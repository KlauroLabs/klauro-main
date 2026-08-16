# Klauro MCP Server - Usage Guide

The MCP server is the agent-facing surface over CAS. It gives AI coding assistants the same source-of-truth graph the UI uses for human inspection.

## Typical Workflow

### 1. Analyze a Codebase

Before querying, analyze the target project:

```
Use the analyze_codebase tool with path="/absolute/path/to/your/project"
```

This runs the CAS pipeline: language detection, framework detection, library detection, AST parsing, relationship extraction, flow analysis, and intelligence generation. When prior incremental state exists, the analyzer reuses it; set `force_full=true` to force a full rebuild.

Results and analysis support files are stored under `~/.klauro/analyses/` unless `KLAURO_STORAGE_PATH` is configured.

Use `get_analysis_focus_profiles` before refreshing a repository when the caller is not sure which layer to pay for. Coding and review agents should normally follow its `agent-fast` recommendation, then request `get_agent_context` with `response_profile: "capsule-only"`. Retry with `first-turn` only when the capsules leave a concrete gap. Human overview surfaces and drilldowns should explicitly request `ui-overview` or `manual-element-description` through `run_analysis_layer`, while runtime/audit work should request `deep-context` only after the fast graph exists. `deep-context` enables semantic retrieval and AI system narrative when configured, but it does not generate bulk element descriptions; those stay manual so agent work never pays that cost by default.

For human-facing narrative quality, call `get_description_enrichment_targets` after analysis. It returns the weak system, capability, service, node, entity, and entry-point descriptions that should be regenerated next, with ready-to-use `run_analysis_layer` or `generate_element_description` arguments. This keeps the fast agent graph cheap while giving the UI a concrete queue for AI-written descriptions instead of accepting deterministic or inventory-style text.

To verify the focus-layer cost model itself, run:

```bash
cd apps/mcp-server
npm run analysis-focus-benchmark -- --output .klauro-analysis-focus-benchmark/latest-report.json --markdown .klauro-analysis-focus-benchmark/latest-report.md
```

The report proves that `agent-fast` enables the core graph, agent context, required AI system narrative, and primary capability summaries, while default MCP/CLI coding routes do not pay for lazy entity/flow/node descriptions or embeddings.

To verify the description layer itself, run:

```
npm run description-quality-benchmark -- --output .klauro-description-quality-benchmark/latest-report.json --markdown .klauro-description-quality-benchmark/latest-report.md
```

The benchmark simulates bad local-model first drafts, verifies the repair prompt
stores AI-sourced service/capability/entity/entry-point descriptions, and
rejects inventory summaries, file coordination summaries, marketing filler, and
unserialized object leaks.

If the analyzers are hosted instead of installed locally, use the remote analyzer path:

```
Use initialize_klauro_project with path="/absolute/path/to/your/project" and mode="remote". Klauro Cloud is the default analyzer URL.
Use get_upload_manifest with path="/absolute/path/to/your/project"
Use analyze_codebase_remote with path="/absolute/path/to/your/project".
```

This uploads a filtered source snapshot, receives CAS from the analyzer service, and saves that CAS into the local MCP cache. After local agent edits, use:

```
Use sync_codebase_remote with path="/absolute/path/to/your/project"
```

This sends only dirty-tree changes to the remote analyzer and updates the local CAS cache with the incremental result. The CLI equivalents are `npm run remote-analyze -- /repo` and `npm run remote-sync -- /repo`. See `docs/mcp/REMOTE-ANALYZER.md` for Docker and deployment details.

### Preview Agent Proposals Before Implementation

When Claude, Codex, or another agent proposes multi-file edits, refactors, removals, or a new codebase skeleton, ask Klauro to preview the proposed codebase state before implementation. CAS stays proposal-agnostic: Klauro analyzes the proposed state as a normal codebase iteration and stores proposal metadata outside CAS.

For an existing codebase:

```
Use preview_codebase_iteration with path="/repo", plan_text="...", and either diff_text or proposed_files.
```

For a greenfield idea:

```
Use preview_greenfield_codebase with plan_text="..." and proposed_files=[...].
```

Agents should include the returned advisory verdict, private preview URL, changed contracts, required checks, and uncertainty in the plan output. A `needs_revision` or `high_risk` verdict is not a hard blocker in v1, but it must be surfaced before implementation.

For large greenfield builds, first call `get_greenfield_build_context` against the empty target folder. It returns first-slice architecture guidance without wasting tokens exploring an empty tree. After the first slice exists, call it again against the same folder; Klauro analyzes the new codebase as normal CAS and returns graph memory, architecture memory, model ownership, boundary ownership, test memory, product-focus guidance, a growth control plane, concepts to reuse, focused files to read, duplicate-prevention rules, and validation checks for the next slice. The context also includes `agent_build_capsule` in `G1` format, a compact prompt-native build language for agents. `G1|0` is the empty-folder first slice and `G1|c` is continuation; its lines carry requested behaviors, architecture patterns, concepts to reuse, owner files, read-first files, next files, do-not-rebuild rules, validation, and the stop rule. Use the G1 capsule first, then expand to full greenfield JSON only when the capsule leaves a concrete gap. The `product_focus` and `growth_control_plane` sections are the expanded agent-facing shift in responsibility: they name the requested product behaviors, the architecture decisions Klauro is carrying, the product-slice stop rule, the architecture budget, concept ownership, duplication gates, what not to spend time rediscovering, and the next product slice definition. Treat each vertical slice as a normal codebase iteration: context, build, preview/analyze, context again. The live scratch harness now passes this compact growth-control context into with-Klauro agents for both empty-folder and continuation waves. The `agent-greenfield-benchmark` includes a continuity trial that proves this behavior by comparing a baseline that rebuilds `User`, `Workspace`, `Project`, and route boundaries against a Klauro-guided slice that reuses the existing models, services, migrations, and tests. The `agent-from-zero-build-context-proof` now runs multi-slice empty-folder builds across multiple domains and compares Klauro-guided growth against baselines that pass tests while duplicating domain concepts.

For multi-project products, run repo/project CAS analysis first for every associated codebase, then call `run_workspace_analysis`. Use `.klauroignore` or `.klaurorc` `source.exclude` when a local workspace contains archived/generated repos or intentionally irrelevant tools. Workspace analysis builds a workspace-level CAS: it composes completed CAS outputs into projects, deployables, interfaces, integration links, runtime topology, data-flow paths, unmatched interfaces, insights, health, risk, activity, telemetry, domains, primary capabilities, workflows, and AI-required narrative. It must not read source code at the workspace layer; missing workspace relationships are repo-level CAS gaps to fix.

Agents should start cross-repo work with `resolve_workspace_analysis` for the handed folder/path, then `get_workspace_agent_context` before broad exploration. The context selects relevant workspace surfaces/connections/dependencies, includes stable ids and absolute repo paths, explicitly says whether each selected surface is deployable, separates source-backed runtime connections from package/code dependencies and inferred candidates, includes health/risk/activity/telemetry/capability/workflow context, estimates token savings against full workspace-level-CAS injection, and tells the agent what to read next through `agent_should_read_next` plus repo-level `get_agent_context` calls. Repo-level `get_agent_context`, `get_idiom_aware_agent_context`, `open_agent_workbench`, and `preflight_agent_change` can receive `workspace_analysis_id` so the agent keeps workspace-level CAS context while working inside a specific CAS.

Check `composition.kind` and `recommended_primary_view` first: interconnected systems need app-to-app topology, composed application architectures need package/library/component architecture, hybrids need both, and disconnected collections should not have fake links invented. Use `get_workspace_freshness` and `validate_was_contract` before trusting older workspace artifacts. Use `get_workspace_analysis` with `detail_level=evidence` only when the context leaves a concrete evidence gap. Read `overview.external_dependencies[].usage` before acting on infrastructure: `source-backed` means code evidence exists, while `topology-only` or `declared` means deployment/config evidence exists but source usage has not been proven. If `workspace_narrative.source` is `ai-required-degraded`, the graph facts are still usable, but the workspace should be refreshed with AI enrichment before using the description or primary capabilities as polished product interpretation.

CLI equivalents:

```
npm run proposal-preview -- /repo --plan-file plan.md --diff-file changes.patch --json
npm run greenfield-build-context -- /empty-or-growing-project --plan-file plan.md --json
npm run greenfield-preview -- --plan-file plan.md --proposed-files files.json --json
```

### 2. Resolve the Best Analysis

For Codex, Claude, Cursor, and other coding agents, the default first call after analysis is:

```
Use resolve_agent_analysis with path="/absolute/path/to/your/project" and task={ "task_type": "modify", "target": "auth" }
```

This is especially important for monorepos and workspace roots. The resolver compares the requested path with stored parent/subproject analyses and returns the selected path, readiness, analysis profile, target matches, and alternatives. Use `selected_path` for subsequent agent tools when it differs from the path you were handed.

Use `get_agent_project_map` when you want to inspect all matching analyses instead of taking the resolver's selected candidate.

### 3. Start with Agent Context

After resolving the analysis path, request the agent bootstrap:

```
Use get_agent_bootstrap with path="/selected/path/from/resolve_agent_analysis"
```

MCP clients that start from prompts can use:

```
Use the agent_coding_session prompt with path="/absolute/path/to/your/project"
```

The prompt runs the same analysis-resolution step internally and prepends the selected path when it chooses a subproject analysis.

MCP clients that prefer resources can read:

```
klauro://{project_name}/agent-bootstrap
```

For a specific task, include task context:

```
Use get_agent_bootstrap with path="/selected/path" and task={ "task_type": "modify", "target": "auth" }
```

This returns readiness, the system summary, graph anchors, answer-pack status, the recommended first MCP calls, a agent context, and a source file read plan. Agents should use it before broad file reads whenever an analysis exists.

### 4. Plan MCP Tool Use

Before deciding which files to inspect, ask CAS for a task-specific tool sequence:

```
Use get_agent_tool_plan with path="/repo" and task={ "task_type": "debug", "target": "billing webhook" }
```

Supported task types are `orient`, `modify`, `debug`, `review`, `trace`, `cross-repo`, and `runtime`. The plan tells the agent which MCP tools to call, why, and when file reads are appropriate.

### 5. Get the Agent Context

When the agent is ready to act, request task-scoped context:

```
Use get_agent_context with path="/repo" and task={ "task_type": "modify", "target": "auth" }
```

The agent context resolves the target, includes coding context, architecture context, risk, callers, callees, tests, behavioral invariant impact, entry/call-chain context, and returns a concrete file read plan. Agents should inspect those files first before expanding to broader source reads. The architecture context is intentionally compact: it names the system type, architecture budget, local patterns such as MVC, MVVM, repository, service layer, mediator, unit of work, and singleton where present, inventory examples, target-relevant owners, a pattern decision matrix, pattern-balance risks, and rules for preserving the codebase's existing shape.

For the first agent turn, especially when token savings must beat codebase-index retrieval, request the smallest useful context:

```json
{ "task_type": "modify", "target": "auth", "response_profile": "capsule-only" }
```

The `capsule-only` profile gives K15/K5 capsules, selected target, first files, token estimate, and validation in the smallest prompt-native form. Ask for `first-turn` when the capsules leave a concrete gap and the agent needs compact JSON fields.

The CLI mirrors this behavior. `npm --silent run agent-context -- /repo --json --compact --quiet` includes each file plan's `line_window`, and the plain-text output prints the same line range so CLI-first agents can avoid reading whole files by default. Use `npm --silent` and `--quiet` for machine-readable JSON so npm's command banner and analyzer maintenance logs do not pollute stdout. Agent contexts are token-bounded by default; ask follow-up MCP tools for deeper context only when the focused context proves insufficient.

### 6. Use The Agent Workbench And Change Lifecycle

For product-level agent work, prefer the composed workflow tools. They turn CAS into a concrete before/during/after loop instead of requiring the agent to manually combine lower-level tools.

Open the workbench before source exploration:

```
Use open_agent_workbench with path="/repo" and task={ "task_type": "modify", "target": "billing webhook", "instructions": "..." }
```

This returns orientation, target resolution, file-read plan, validation plan, repo-local rules, `signal_quality`, evidence policy, and stop conditions. `signal_quality` calls out thin or missing signals such as unmapped tests, patterns, idioms, invariants, low purpose confidence, and analyzer errors.

Before presenting a multi-file plan or editing, run preflight:

```
Use preflight_agent_change with path="/repo", target="billing webhook", plan_text="...", and files=["..."]
```

Agents should include the returned `plan_output_block` in their plan when there are warnings, unknowns, affected invariants, missing tests, or migration/auth concerns. Findings include `evidence_source` so agents can tell CAS-backed facts apart from plan-text heuristics.

To retrieve the living “how to work in this repo” context:

```
Use get_codebase_agent_rules with path="/repo"
```

This returns architecture, idiom, invariant, testing, source-reading, confidence, and signal-quality rules derived from CAS.

When the task specifically needs architecture-shape guidance without the rest of a agent context, use:

```
Use get_architecture_context with path="/repo" and target="billing"
```

This returns a bounded architecture view for planning and editing: primary system type, architecture budget, detected patterns, inventory counts, target-relevant models/views/controllers/services/repositories/handlers, pattern-balance risks, and agent rules. Use it before introducing a new architectural style or moving behavior across layers.

To explain the shape of a proposed or actual diff:

```
Use explain_change_shape with path="/repo" and diff_text="..."
```

This maps changed files to CAS nodes, tests, idioms, invariants, signal-quality warnings, and an inferred scope such as `localized`, `api-contract`, `security-boundary`, or `schema-contract`.

After edits, use the combined final gate:

```
Use validate_agent_change with path="/repo"
```

This validates the working tree against repo-local idioms and behavioral invariants, then returns an advisory finalization rule. Treat `does_not_fit_yet` as a strong review signal that should be resolved or explicitly explained before finalizing.

### 7. Validate Behavioral Invariants After Edits

Before claiming a code change is complete, validate the working diff against CAS behavior-level invariants:

```
Use validate_behavioral_invariants with path="/repo" and target="auth"
```

The validator reads working-tree and staged changes by default. It can also validate an explicit `files` list or supplied `diff_text`. Treat `status="fail"` as a blocker and `status="warn"` as evidence that focused tests, migration coverage, or direct invariant review is still needed.

### 8. Check Default-Use Readiness

Use this when deciding whether an agent should rely on MCP by default:

```
Use evaluate_agent_readiness with path="/repo"
```

Or read:

```
klauro://{project_name}/agent-readiness
```

This checks analysis errors, graph integrity, entry and exit coverage, call chains, method calls, answer-pack gaps, evidence, tests, security surfaces, runtime links, and flow coverage. `agent_context_ready=true` means CAS/MCP is strong enough to be the first path for the repository.

For the full agent-context-ready doctor, including freshness, test discovery evidence, runtime SDK proof, and saved golden snapshot status:

```
Use get_agent_doctor with path="/repo"
```

Or read:

```
klauro://{project_name}/agent-doctor
```

To install agent-context-ready instructions into the repository for future agents:

```
Use install_agent_default_config with path="/repo"
```

This writes `.klauro/agent-defaults.json` and `.klauro/agent-defaults.md`. Agents can read those files to know the required first MCP calls before broad file reads.

The installed defaults intentionally use a selected-path placeholder for follow-up calls. Agents should call `resolve_agent_analysis` first and then use the returned `selected_path` for doctor, start-context, agent-context, invariant validation, and benchmark proof calls when it differs from the original path.

### 9. Orient with get_summary

After analysis, call `get_summary` to understand the system at a high level:

```
Use the get_summary tool with path="/absolute/path/to/your/project"
```

This returns the condensed intelligence view: what the system does, its tech stack, architecture layers, key capabilities, and scale metrics.

#### Progressive availability — use structure now, prose enriches in the background

Klauro returns the **deterministic structure** — call graph, routes, entry points,
file nodes, data flows, entities, node/edge counts — the moment analysis completes
(typically ~200ms after a warm analyze). That structure is complete and
authoritative; **start working off it immediately.** The **AI-written prose** (the
system-purpose summary and per-element descriptions) is generated in a background
pass, so it may lag by a few seconds on a fresh analysis.

Every response is stamped so you never guess which you have:

- **`ai_enrichment`** on `get_summary` / `analyze_codebase` output:
  - `ready` — AI prose is included.
  - `pending` — you have deterministic text now; the background pass is still
    running. Re-call in a few seconds **only if** you specifically need the richer
    narrative. Do not block on it.
  - `disabled` / `synchronous` — no background pass; the text you have is final.
- **`description_source`** on `get_analysis_facts` and per-element results:
  `deterministic` | `ai` | `manual` | `reused` — tells you whether a description is
  precomputed structure or AI-enriched prose.

Rule of thumb: **the facts are the product; the prose is flavor.** Act on the
structure first, and only re-fetch for prose when the narrative is the actual thing
you need.

### 9a. Understand at Every Level: Capability -> Flow -> Step -> Function

`get_summary` names the capabilities; drill into how one actually works with
`get_flow_concepts` — a named flow per entry point, broken into ordered semantic
steps (Validate -> Charge -> Persist -> Notify), not a raw function chain. Each
flow and each step carries the same contract: **Input, Logic, Side-effects**
(split into `state_changes` — DB/cache writes — vs `external_integrations` —
API/webhook/SDK/queue calls), **Output**, and **Constraints** (business
rules/invariants/guards, deterministically extracted, never fabricated). A step
maps to function(s) 1:1, 1:many, or a sub-section (line range) of one large
function — drill that far down with `get_coding_context` or `get_call_chain`.

```
get_summary (capability) -> get_flow_concepts (flow, ordered steps) -> get_coding_context / get_call_chain (concrete function)
```

Use this path to think in flows and steps, not just files: "what does the
Checkout flow do, what are its steps, what does the Persist step touch" is
answerable directly, instead of reconstructed by hand from file reads.

### 9b. Coordinate at the Concept Level — Parallel by Default

In a multi-agent workspace, default to splitting fannable work across agents and
running them concurrently through the fabric — this is the normal way to work
here, not a fallback reserved for when work happens to collide. Each agent
announces its scope via `claim_work`/`check_collision` in the same conceptual
vocabulary as the hierarchy above: "I own the Persist step of the Checkout
flow," "I'm changing the Order entity's constraints," not "editing file X lines
40-60." Two agents on the same flow but different steps is safe and expected;
the fabric's job is to catch real conceptual overlap (semantic conflicts a
textual merge would miss — see `check_conceptual_conflicts`), not to gate
disjoint work. The fabric is always-on ambient awareness, not a lock: you do not
need to fear many agents working this codebase at once, because announcing
concept-level scope keeps the fleet coherent as it grows. Treat one-agent-at-a-
time serial work as the exception that needs a reason.

### 10. Navigate Progressively

Use `get_level` to explore the codebase top-down:

1. `get_level` with `level=0` -- system-wide view (root modules, packages)
2. `get_level` with `level=1` -- major subsystems (controllers, services, core modules)
3. `get_level` with `level=2` -- individual components (classes, functions, handlers)
4. Continue deeper as needed

Each call returns the available levels with node counts, so you always know what's above and below. Cross-level edges show how the current level connects to others.

### 11. Drill Into Specifics

From there, drill into targeted areas:

- **Understand the API surface**: `get_entry_points`, `get_route_table` (paginated, use `limit`/`offset`)
- **Explore data model**: `get_database_schema`, `get_data_entities` (paginated)
- **Find specific code**: `search_nodes` with query text (defaults to hybrid lexical + semantic mode; pass `mode` to force `lexical`, `semantic`, or `hybrid`)
- **Find code by description**: `semantic_search` with a natural-language query when the symbol name is unknown; `get_embedding_status` to confirm the index exists
- **Trace execution**: `get_callers` / `get_callees` / `get_call_chain` (use `chain_id` for full detail)
- **Understand a capability's named flows and steps**: `get_flow_concepts` — ordered steps with I/L/S/O + Constraints per flow, tied to concrete functions; the middle rung between `get_summary` and `get_coding_context`/`get_call_chain`
- **Assess safety**: `assess_change_risk` before modifying code
- **Check test coverage**: `find_tests`, `get_test_summary`, `get_flow_coverage` (use `chain_id` for per-flow detail)
- **Review security**: `get_security_overview`
- **Discover patterns**: `get_patterns` (summaries), `get_pattern_instances` (drill into specific pattern)
- **Preserve architecture shape**: `get_architecture_context` before significant edits to see system type, MVC/MVVM/repository/service/mediator/unit-of-work/singleton inventory examples, pattern decision matrix, pattern-balance risks, and target-relevant owners
- **Explore concepts**: `get_domain_concepts` (filterable, paginated)
- **Understand recent changes**: `get_changes_since`, `get_change_summary`, `get_hot_spots`, `get_analysis_snapshots`
- **Resolve monorepos/subprojects**: `resolve_agent_analysis`, `get_agent_project_map`
- **Use product-level agent workflows**: `open_agent_workbench` before broad source reads, `preflight_agent_change` before plans/edits, `explain_change_shape` for proposed diffs, and `validate_agent_change` before finalizing; inspect `signal_quality` and finding `evidence_source` before relying on the context
- **Check freshness and test discovery**: `get_analysis_freshness`, `get_test_discovery_evidence`
- **Prove answerability**: `run_answer_pack` with `pack="mastery"`
- **Connect repos**: `get_cross_repo_links` with related analyzed paths
- **Persist workspace graphs**: `save_workspace_graph`, `get_workspace_graph`, `verify_workspace_link`
- **Validate CAS completeness**: `validate_cas_contract`, `save_cas_golden_snapshot`, `compare_cas_golden_snapshot`
- **Check integration analyzer depth**: `get_integration_depth_report`
- **Avoid rebuilding existing behavior**: `get_capability_memory` or the `capability_memory` field in `get_agent_context` before adding services, routes, workers, models, packages, or new feature slices
- **Inspect and validate behavior-level rules**: `get_behavioral_invariants` before edits and `validate_behavioral_invariants` after edits for tenant scope, auth, DB constraints, migrations, and test coverage
- **Inspect and validate repo-local practices**: `get_codebase_idioms` and `get_idiom_examples` before edits, then `validate_codebase_idioms` after edits so changes match local naming, placement, testing, migration, error/logging, and boundary conventions
- **Inspect MCP storage**: `get_storage_health`
- **Map runtime back to code**: `get_runtime_event_contract`, `get_runtime_sdk_package`, `correlate_runtime_event`, `record_runtime_event`, `get_runtime_observations`, `get_runtime_trace`

---

## Common Scenarios

### Starting a coding session

Use `get_agent_bootstrap` first, or use the `agent_coding_session` prompt when your MCP client supports prompts:

```
Use get_agent_bootstrap with path="/absolute/path/to/your/project"
```

Then use `get_agent_context` with the user's task, including the user's exact `instructions` and `success_criteria` when the request is behaviorally specific. Use source files after MCP identifies the relevant nodes, files, line windows, tests, validation commands, or gaps.

You can also use the `architectural_context` prompt to inject full system awareness:

```
Use the architectural_context prompt with path="/absolute/path/to/your/project"
```

This gives the AI assistant knowledge of system type, tech stack, architecture layers, API routes, database schema, capabilities, security posture, and design patterns -- all in a single context injection.

To prove duplicate-work avoidance across repos, run `npm run agent-capability-memory-benchmark` from `apps/mcp-server/`. It compares source-search-only behavior against CAS-backed capability memory and reports whether agents receive explicit reuse/extend/extract decisions before creating overlapping code.

### Before modifying code

1. Call `get_agent_tool_plan` with `task_type="modify"` and the target.
2. Call `get_agent_context` with the same task.
3. Use the agent context's `architecture_context` to preserve the existing pattern budget and owner categories. Do not introduce a new paradigm unless the context shows no local fit or the user explicitly asks for that architectural change.
4. Check the agent context's `capability_memory` or call `get_capability_memory` if the change adds behavior, so the plan explicitly reuses, extends, extracts, or distinguishes existing capabilities before creating new code.
5. Read the agent context's file read plan first, starting with each item's `line_window` when present.
6. Use the agent context's risk, callers, callees, tests, and validation plan to decide the edit and verification path.
7. Run the agent context's validation commands. In monorepos these may route to package roots, such as `cd packages/analyzer-core && npm test`.
8. After edits, call `validate_behavioral_invariants` and `validate_codebase_idioms` against the working diff before finalizing.

The validation plan is part of the product surface, not a benchmark-only artifact. It gives agents focused test/typecheck/build commands when CAS can infer them, lists tests to inspect first, and tells agents to report an environment blocker instead of installing dependencies or doing broad setup unless the task explicitly asks for that. The agent context also includes `architecture_context`, behavioral invariants, invariant impact, and `idiom_context` so agents preserve architectural paradigms, tenant/org scope, auth boundaries, DB constraints, migration contracts, test coverage, naming, file placement, module boundaries, validation style, error/logging style, async style, and configuration practices while editing.

Or use the `safe_modification_guide` prompt which composes all of these into a single output.

### Understanding a feature

1. Search for relevant nodes: `search_nodes`
2. Get the node details: `get_node`
3. Trace the call chain: `get_call_chain` from the entry point
4. Check what it calls: `get_callees`
5. See the workflow: `get_workflows`

### Finding code by concept

When the task describes the target conceptually -- "where do we validate user input", "the code that sends emails", "refund webhook handling" -- and no class or file is named, use semantic retrieval instead of broad file reads:

```
Use semantic_search with path="/repo" and query="where do we handle refund webhooks"
```

Each result is a graph-anchored CAS node carrying its callers, callees, test count, entry-point status, and risk, so retrieval lands directly inside the graph. `search_nodes` runs the same hybrid lexical-plus-semantic path by default; pass `mode="lexical"` for keyword-only matching or `mode="semantic"` for vector-only.

To confirm semantic retrieval is available and current for an analysis:

```
Use get_embedding_status with path="/repo"
```

This reports the embedding model, coverage, and `generated_at`, or that no index exists. When no index is present, `semantic_search` and hybrid mode fall back to lexical search.

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

For the strongest agent-context-ready signal:

```
Use get_agent_doctor with path="/absolute/path/to/project"
```

The doctor combines CAS contract validation, source freshness, test discovery evidence, runtime SDK proof, and golden snapshot status into one report.

To make this default path reusable by agents:

```
npm --silent run agent-install -- /absolute/path/to/project --json
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

Repos can also provide `.klauro/analysis-expectations.json`, `klauro.analysis.json`, or `analysis-expectations.json`; then call `evaluate_analysis_truth` without an inline expectation.

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

The report distinguishes `missing_surfaces` from `unobserved_surfaces`. Missing surfaces are analyzer-depth gaps for behavior the code appears to use. Unobserved surfaces are optional integration capabilities that were not present in the analyzed codebase, so agents should not treat them as implementation gaps.

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

To ask "what bugs should I address today" with production signal, first ingest or record runtime observations, then use:

```
Use get_operational_priorities with path="/repo"
Use get_agent_context with path="/repo" and task={ "task_type": "debug", "target": "<top static_target.file>", "response_profile": "capsule-only" }
```

`get_operational_priorities` ranks stored ingested telemetry by error count,
latency, traffic volume, static risk, missing tests, and CAS correlation. The
agent context keeps the runtime priority compact in K15/K5 while still requiring
normal idiom, invariant, and test validation before edits.

To verify that runtime context changes agent priority without bloating prompt
context:

```
npm run runtime-impact-benchmark -- --output .klauro-runtime-impact-benchmark/latest-report.json --markdown .klauro-runtime-impact-benchmark/latest-report.md
```

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

Fresh analyses can be used as the first source of context. Stale analyses should be refreshed with `analyze_codebase` before agent-context-ready agent work.

### Maintaining golden CAS snapshots

After a repository reaches a trusted CAS shape, save its snapshot:

```
Use save_cas_golden_snapshot with path="/absolute/path/to/project"
```

Later, compare the current analysis against that saved shape:

```
Use compare_cas_golden_snapshot with path="/absolute/path/to/project"
```

The command-line equivalents from `apps/mcp-server/` are:

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

From `apps/mcp-server/`:

```
npm run agent-gauntlet
```

This analyzes the configured repositories and runs `evaluate_agent_readiness` against each one. The report is written to `.klauro-agent-gauntlet/latest-report.json` unless `--output` is provided. A passing target has `agent_context_ready=true`, meaning agents should use MCP as the first path for that repo.

### Running the agent usefulness benchmark

From `apps/mcp-server/`:

```
npm run agent-benchmark
```

This checks whether task agent contexts resolve targets, produce a focused file read plan, include the selected target file, return follow-up MCP calls, and beat a cold repo read. The report includes file-reduction percentages so agent adoption is measured against the baseline of reading broad source files.

For the with-Klauro vs without-Klauro benchmark:

```
npm run agentic-benchmark -- --repo klauro=/absolute/path/to/repo --task-type modify --target auth
```

or through MCP:

```
Use run_agentic_benchmark with paths=["/absolute/path/to/repo"] and task={ "task_type": "modify", "target": "auth" }
```

The JSON and Markdown reports include estimated file counts, estimated context tokens, estimated work time, speedup ratios, and a two-agent run sheet. The run sheet is designed for live trials where Agent A receives the task without Klauro and Agent B receives the same task with Klauro, then records wall time, provider-reported input/output tokens, tool calls, files read, tests, and task result.

For a larger proof suite across discovered real repositories:

```
npm run agentic-benchmark-suite
```

This runs up to six discovered repositories by default and generates up to eight task cards per repository. Task cards include orientation, modification, debugging, tracing, runtime correlation, data-flow, external-boundary, and test-focused work when the CAS contains those surfaces. The report includes per-task success gates, projected baseline success, cached with-Klauro solution time, first-run with-Klauro solution time including amortized analysis, targeted-search solution time without Klauro, token deltas, and file-read deltas.

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

For generated suites, use `--live-task-type` or `--live-task-category` to keep live runs focused on harder edit/debug/review tasks instead of spending live-agent budget on easy orientation tasks.

When live commands are supplied, the harness creates paired repository copies under `.klauro-agent-live-trials/`, writes separate with-Klauro and without-Klauro prompts, initializes each copy as a clean git baseline, runs each command, records duration, changed files, added/deleted lines, test status, provider token metrics when reported, and writes binary diffs. The with-Klauro arm also receives a real CAS-derived agent-context artifact for the copied repo; if MCP tools are unavailable in the trial runtime, the agent reads that artifact instead of generating analysis inside its own turn. A deterministic orchestrator compares both diffs and reports patch quality, hidden-validation pass/fail, command completion, changed-file precision, time reduction, token reduction, and confidence as separate signals.

For fair live proof, write tasks in behavioral terms and keep implementation paths out of the agent prompt. Hidden validation can still assert exact files, strings, tests, or diffs through `--test-command`; the no-Klauro arm should not receive the path that Klauro is supposed to discover.

Patch quality answers whether the resulting diff solved the requested behavior. Completion score answers whether the agent process ended cleanly without timeout or environment churn. Keep those separate: a correct patch that passes hidden validation but times out while trying to run a broken broad test environment should show high patch quality and lower completion, not a failed fix.

See `docs/mcp/AGENT-PERFORMANCE-PROOF.md` for the current tracked proof summary, including copied-repo live A/B results, deterministic benchmark results, and incremental edit-loop results.

To cold-review the actual product output from the latest machine proof, without re-analyzing every repository:

```
npm run analysis-output-cold-review -- --output .klauro-analysis-output-cold-review/latest-report.json --markdown .klauro-analysis-output-cold-review/latest-report.md
```

This samples large apps, infrastructure repos, library/SDK repos, small/simple repos, and Klauro itself from `.klauro-agent-proof-machine/latest-report.json`. It scores agent-context usefulness separately from human-facing narrative quality. A `warn` result is useful evidence: it means MCP context are helping agents, but the UI/human description layer still needs AI enrichment before claiming the analysis output is fully polished.

To turn that cold-review debt into an explicit enrichment queue:

```
npm run analysis-narrative-enrichment-proof -- --output .klauro-analysis-narrative-enrichment-proof/latest-report.json --markdown .klauro-analysis-narrative-enrichment-proof/latest-report.md
```

This loads the cold-review output, checks every narrative-debt analysis can be
routed to `run_analysis_layer` or `generate_element_description`, verifies AI
description mechanics, and proves `agent-fast` still has zero optional
enrichment work while UI overview pays for narrative quality explicitly.

To execute a bounded slice of that queue with the configured AI provider, run:

```bash
npm run analysis-narrative-enrichment-runner -- --max-targets 5 --max-targets-per-repo 1 --output .klauro-analysis-narrative-enrichment-runner/latest-report.json --markdown .klauro-analysis-narrative-enrichment-runner/latest-report.md
```

The runner records attempted targets, generated targets, generated-but-still-weak
targets, target removals from the queue, before/after narrative target counts,
and the generated descriptions. Use `--dry-run` first when checking the queue
shape, and keep this on the `ui-overview` path so default agent-fast MCP context
do not pay for narrative generation.

Agent command templates may use:

- `{workspace}` - copied repo path for that arm
- `{prompt_file}` - prompt file path
- `{metrics_file}` - optional JSON metrics file the agent can write
- `{result_file}` - optional JSON result file the agent can write
- `{arm}` - `with-klauro` or `without-klauro`
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

The orchestrator command receives `{evaluation_input}`, `{evaluation_file}`, `{with_workspace}`, `{without_workspace}`, `{with_diff}`, and `{without_diff}`. If it writes JSON with `with_klauro_quality_score`, `without_klauro_quality_score`, `with_klauro_success`, `without_klauro_success`, `confidence`, and `reasons`, those scores override the deterministic evaluator while preserving all raw artifacts.

Through MCP:

```
Use run_agent_quality_benchmark with paths=["/repo/a", "/repo/b"], max_tasks_per_repo=8, agent_with_command="agent-with --workspace {workspace} --prompt-file {prompt_file}", agent_without_command="agent-without --workspace {workspace} --prompt-file {prompt_file}", orchestrator_command="judge-agent --input {evaluation_input} --output {evaluation_file}", test_command="npm test", max_live_tasks=4
```

### Running the incremental value benchmark

From `apps/mcp-server/`:

```
npm run incremental-benchmark
npm run incremental-locality-benchmark
```

The first command copies discovered repositories into isolated workspaces, runs an initial analysis, reruns analysis with no source changes, edits one source file safely, reruns incremental analysis, and then generates an agent context from the edited CAS. With `--verify-full`, it also runs a fresh full analysis after the edit and verifies exact node, edge, entry-point, and exit-point identity.

The locality command separately proves single-symbol, file, package, deployable, and cross-repository edit scopes. It records analyzed and reused files, canonical package and deployable boundaries, changed and reused member analyses, and exact cold-analysis parity for every scope.

The report shows whether iterative analysis stayed incremental, how much faster it was than a full rebuild, whether the edit produced a change summary, how many files are tracked in incremental state, how many file-cache entries exist, and whether an agent can immediately get a focused post-edit agent context instead of rediscovering the repo.

Copied workspaces are discarded by default after each target so proof runs do not accumulate large dependency trees. Use `--keep-workspaces` only when debugging a failed target.

To run it through MCP:

```
Use run_incremental_value_benchmark with paths=["/repo/a", "/repo/b"], verify_full=true, max_targets=4
```

To retrieve the current agent-performance proof through MCP:

```
Use get_agent_performance_proof
```

By default the proof query uses reports generated in the last 7 days so stale benchmark runs do not leak into current evidence. Pass `since_days=0` only when you intentionally want all persisted history.

For one report family, use `get_agentic_benchmark_report` with `benchmark_type="live-agent-quality-ab"` or `benchmark_type="incremental-analysis-agent-value"`. Markdown rendering is selected from the stored report type, so live-quality, deterministic, and incremental reports are not flattened into the wrong format.

### Running the live idiom quality benchmark

From `apps/mcp-server/`:

```
npm run agent-idiom-benchmark -- --repo app=/repo --live --agent-with-cmd "agent-with --workspace {workspace} --prompt-file {prompt_file}" --agent-without-cmd "agent-without --workspace {workspace} --prompt-file {prompt_file}" --test-command "npm test"
```

This creates copied-repo A/B tasks where both agents can pass correctness, but the with-Klauro arm receives CAS `idiom_context`. The evaluator scores correctness, idiom conformance, minimality, test relevance, boundary preservation, and file targeting. Acceptance requires no with-Klauro correctness regression and a positive idiom-conformance delta.

Through MCP:

```
Use run_agent_idiom_benchmark with paths=["/repo/a", "/repo/b"], max_tasks_per_repo=2, agent_with_command="agent-with --workspace {workspace} --prompt-file {prompt_file}", agent_without_command="agent-without --workspace {workspace} --prompt-file {prompt_file}", test_command="npm test", max_live_tasks=4
```

### Running the machine-wide agent proof

From `apps/mcp-server/`:

```
npm run discover-real-repos
npm run agent-proof-fast
npm run agent-proof-machine -- --agent-with-cmd "agent-with --workspace {workspace} --prompt-file {prompt_file}" --agent-without-cmd "agent-without --workspace {workspace} --prompt-file {prompt_file}" --max-live-tasks 6
```

For Claude Code live proof or MCP-guided execution, prefer a lean command so the measured token delta reflects the Klauro context and source reads instead of unrelated local memory, hooks, plugins, or session persistence:

```
claude -p --safe-mode --no-session-persistence --permission-mode bypassPermissions --add-dir {workspace} --output-format json -- "$(cat {prompt_file})"
```

Use the same lean mode for both with-Klauro and without-Klauro arms. Keep the `--` before the prompt so Claude does not treat the prompt as another `--add-dir` value. Benchmark reports label non-lean Claude commands as `full-agent` and keep provider-token regressions visible.

For normal agent work, call `get_agent_context` with `task.response_profile="capsule-only"` when the agent needs to start cheaply. The response includes `context_capsule` in Klauro Agent Context Language (`K15`) format, `execution_capsule` in Klauro Execution Capsule (`K5`) format, selected target, first files, token estimate, and the expansion rule. Use `first-turn` only when the capsule-only response leaves a concrete gap and the agent needs compact JSON fields. Agents should read K15 for orientation, restore default file extensions, execute K5 before broad file exploration or full-context follow-up calls, and expand only when the capsules are ambiguous or source evidence proves the target moved. `K15` carries compact orientation, selected node, default extension restoration, indexed file roles, idioms, reuse, risk, validation, and expansion rules. `K5` carries exact path dictionaries with read/edit sigils plus file-scoped operations for known-fix/direct-patch work. See `docs/mcp/EXECUTION-CAPSULE.md`.

For new-codebase work, call `get_greenfield_build_context` and read
`agent_build_capsule.capsule` before creating files. The G1 capsule is the
greenfield equivalent of K15/K5: it compresses first-slice or continuation
guidance into behavior, pattern, owner, next-file, validation, and
do-not-rebuild lines so the agent can spend tokens on product code instead of
rediscovering architecture.

To verify that greenfield prompt compression is still working:

```
npm run greenfield-build-codec-benchmark -- --output /tmp/klauro-greenfield-build-codec-benchmark.json
```

To verify the compact MCP context against competitor-shaped agent context baselines:

```
npm run competitor-baseline-benchmark -- --output .klauro-competitor-baseline-benchmark/latest-report.json --markdown .klauro-competitor-baseline-benchmark/latest-report.md
```

This compares Klauro against two explicit proxies: a Cursor-style editor/index retrieval baseline and a Linear-style issue/workflow/code-context baseline. It is not a private vendor-product measurement; it is a repeatable proof that Klauro's CAS/MCP context beats both "indexed code likely files" and "issue plus repo context plus review workflow" shapes on context readiness and token discipline. The report must show quality lift and token reduction against both baselines before final acceptance treats the proof as passing.

To see which real installed intelligence competitors and agent executors can be benchmarked on this machine:

```
npm run competitor-readiness -- \
  --output .klauro-competitor-readiness/latest-report.json \
  --markdown .klauro-competitor-readiness/latest-report.md
```

This is a readiness report, not a win claim. It separates installed code-intelligence competitors that the gauntlet can already measure from agent executors that can run copied-repo A/B tasks. Klauro is not the autonomous coding agent in this comparison; Klauro is the codebase, product, and workspace intelligence layer being handed to agents. Cursor Agent, OpenCode, Aider, Cline, Continue, Claude, Codex, or similar tools are executor arms. They count as live proof only when they can run in the copied-repo harness, edit files, and report metrics or enough artifacts for Klauro to score quality, speed, and token discipline.

To run true installed-tool comparisons after an agent executor and a competing intelligence source expose local adapters:

```
npm run competitor-live-benchmark -- \
  --klauro-cmd "YOUR_KLAURO_ENABLED_AGENT_COMMAND" \
  --cursor-cmd "YOUR_CURSOR_AGENT_COMMAND" \
  --linear-cmd "YOUR_LINEAR_AGENT_COMMAND" \
  --max-live-tasks 3 \
  --output .klauro-true-competitor-benchmark/latest-report.json \
  --markdown .klauro-true-competitor-benchmark/latest-report.md
```

This uses the copied-repo live A/B harness, not a proxy. Each command receives the same seeded engineering task in its own repo copy. The Klauro arm receives the compact CAS/MCP agent context; the comparison arm receives the task plus the selected non-Klauro intelligence source or baseline context. The harness captures wall time, git diff, changed files, validator result, stdout/stderr tails, and token metrics when the executor exposes them. Command templates may include `{workspace}`, `{prompt_file}`, `{metrics_file}`, `{result_file}`, `{arm}`, and `{task_id}`. For fair token proof, adapters should write `provider_input_tokens`, `provider_output_tokens`, and `provider_total_tokens` to `{metrics_file}` when available. The included codebase-memory adapter is `src/codebase-memory-agent-adapter.ts`; it indexes the copied repo with the real installed `codebase-memory-mcp` binary, injects architecture/search context, and runs Codex as the same executor.

Use `agent-proof-fast` for normal local development. It still discovers every real Git repo under `/Users/michaelshattuck/dev` and reports every repo as passed, failed, unsupported, or skipped with a reason, but it analyzes a bounded sample with source-file and timing budgets so the proof does not monopolize the workstation.

Use `agent-proof-machine` or `analysis-perfection-gauntlet` only when you intentionally want the full local-machine proof. The full mode excludes generated benchmark/live-trial copies and dependency/cache/build directories, includes nested standalone Git repos, and runs analysis/readiness/idiom checks, incremental edit-loop checks, and idiom proof for eligible repos. Full mode is CPU/disk heavy on large repo sets by design; prefer it before releases or after analyzer changes that could affect many languages/frameworks.

Proof, preview, and live-trial commands create temporary copied workspaces. They are removed on successful runs, but interrupted runs can leave generated temp artifacts behind. To inspect or prune only allowlisted Klauro-generated temp workspaces:

```
npm run storage-report -- --include-temp-artifacts --max-bytes 1073741824
npm run storage-prune -- --include-temp-artifacts --max-bytes 1073741824 --confirm
```

MCP agents can use the same maintenance path without shelling out:

```
Use get_storage_maintenance_report with include_temp_artifacts=true and max_bytes=1073741824
Use prune_storage_artifacts with confirm_delete=true, include_temp_artifacts=true, and max_bytes=1073741824 only after the user approves deletion.
```

The temp cleanup path is intentionally separate from analysis retention. It does not delete `~/.klauro/analyses` unless `--include-analyses` is explicitly supplied.

Resource controls:

```
npm run agent-proof-machine -- --mode fast --max-targets 4 --max-source-files 1000 --analysis-budget-ms 20000 --incremental-budget-ms 20000
npm run agent-proof-machine -- --mode full --analysis-concurrency 1 --incremental-concurrency 1
```

To enforce the complete non-UI product bar from the latest proof artifacts:

```
npm run agent-vision-acceptance
```

This fails if the recent CAS mastery, default-agent-readiness, real-repo vision, deterministic usefulness, deterministic quality, indexed-codebase baseline proof, copied-repo live A/B proof, live idiom-quality proof, machine-wide repo accounting, or incremental edit-loop reports no longer support agent use. It is the quick acceptance gate for proving that Klauro is materially useful to agents before relying on MCP by default.

To regenerate the proof from scratch and then enforce the same gate:

```
npm run agent-proof-full
```

This runs MCP typecheck/tests, the analysis mastery gauntlet, default-agent-readiness gauntlet, real-repo vision gauntlet, deterministic usefulness benchmark, deterministic quality benchmark, incremental edit-loop benchmark, analysis focus proof, indexed-codebase baseline proof, compact context proof, runtime impact proof, and final acceptance gate in sequence.

### Running the vision gauntlet

From `apps/mcp-server/`:

```
npm run vision-gauntlet
```

This runs the full technical proof across discovered real repos: CAS contract validation, answer-pack readiness, agent-context-ready readiness, runtime event contract coverage, runtime SDK generation, test discovery evidence, and cross-repo links. Default discovery includes Klauro, Kadra, Money, Zerac, Soon, and SoundSyft when those repos exist under `~/dev`. Use `--repo name=/path/to/repo` to add or override targets. The report is written to `.klauro-vision-gauntlet/latest-report.json` unless `--output` is provided.

### Running the cross-repo contract gauntlet

From `apps/mcp-server/`:

```
npm run contract-gauntlet
```

This analyzes paired fixture repositories and verifies that CAS-derived consumed contracts link to provided contracts with expected confidence and no unexpected conflicts.

### Running the analysis mastery gauntlet

From `apps/mcp-server/`:

```
npm run analysis-gauntlet
```

This runs the built-in ground-truth fixture and any repos passed with `--repo`. It checks truth expectations, framework depth, runtime instrumentation readiness, semantic map availability, and agent task proof. The report is written to `.klauro-analysis-gauntlet/latest-report.json` unless `--output` is provided.

---

## Re-analyzing

Run `analyze_codebase` again on the same path to refresh the analysis.

Storage behavior:

- The main `{slugified-project-name}.json` analysis file is replaced with the latest CAS output.
- `index.json` continues to map project paths to the latest analysis file.
- Per-project incremental state is stored under a project directory inside `~/.klauro/analyses/`.
- File-level cache entries are stored under that project directory's `file-cache/`.
- Change history is stored as `change-history.json`.
- Analysis snapshots are stored under `snapshots/` and capped by the MCP storage layer. Defaults are 10 snapshots and 512 MB per project; set `KLAURO_MAX_SNAPSHOTS` or `KLAURO_MAX_SNAPSHOT_BYTES` when a longer local time-travel window is needed. Incremental snapshots are throttled to at most once per 60 seconds by default while the latest CAS file is still updated on every changed analysis; set `KLAURO_INCREMENTAL_SNAPSHOT_INTERVAL_MS=0` to snapshot every incremental edit.
- Saved CAS golden snapshots are stored as `cas-golden-snapshot.json`.
- Runtime observations are stored as `runtime-observations.json`.
- Persisted workspace graphs are stored under `workspace-graphs/`.
- Agentic benchmark, quality, live, and incremental benchmark reports are stored under `agentic-benchmarks/`, with `latest.json` pointing to the latest report. MCP benchmark tools persist reports automatically, and the benchmark CLIs persist their generated reports after writing local JSON/Markdown artifacts.
- Interrupted proof, preview, and live-trial runs may leave allowlisted `klauro-*` temp workspaces under the OS temp directory. Use `npm run storage-report -- --include-temp-artifacts` or the `get_storage_maintenance_report` MCP tool to inspect them. Use `npm run storage-prune -- --include-temp-artifacts --confirm` or the guarded `prune_storage_artifacts` MCP tool to delete them only after explicit approval. Analysis files are not included in this cleanup unless `--include-analyses` is provided.

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
