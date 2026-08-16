# Klauro MCP Server - Tools Reference

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
| `analysis_focus` | string | no | Layered profile: `agent-fast`, `ui-overview`, `deep-context`, or `full` |

**Returns:** `{ status, analysis_type, analysis_focus, path, name, nodes, edges, entry_points, analyzers_run, errors, phases }`. Incremental runs also include `change_summary` with files changed, node changes, and risk level.

Focus profiles let agents and UI flows pay for the context they need:

- `agent-fast`: prioritizes graph, entry points, risks, idioms, tests, required AI system/capability summaries, and compact agent contexts; defers lazy entity/flow/node descriptions and embedding-heavy layers.
- `ui-overview`: prioritizes visualization, required AI system/capability summaries, and selected human-facing lazy descriptions; defers embedding-heavy layers.
- `deep-context`: keeps the core graph and required AI system/capability summaries, enables embedding-backed semantic retrieval where configured, and still defers bulk entity/flow/node descriptions unless requested.
- `full`: uses repository and environment defaults.

### `get_analysis_focus_profiles`

Choose the cheapest useful analysis focus before triggering a layer. This is the MCP control point that keeps coding agents on `agent-fast` by default with required AI system/capability summaries, while letting UI and drilldown flows explicitly opt into lazy entity/flow/node descriptions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `trigger` | string | no | `mcp`, `cli`, `ui`, `inspector`, `manual-description`, `runtime`, or `unknown` |
| `task_type` | string | no | Optional task hint such as `modify`, `debug`, `architecture audit`, `visual inspection`, or `description generation` |

**Returns:** A recommendation plus all focus profiles. The recommendation includes `recommended_focus`, `recommended_layer`, `reason`, `token_policy`, and the layers deferred until needed.

Use this when an agent or client is about to analyze or refresh a repo and needs to avoid spending tokens/time on narrative or deep context layers prematurely.

### `get_description_enrichment_targets`

Return the exact descriptions that need AI enrichment next. Use this when UI overview or drilldown text is deterministic, generic, inventory-like, missing, or rejected by the usefulness review.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute path to the analyzed project directory |
| `limit` | number | no | Maximum targets to return |

**Returns:** `analysis_id`, total target count, and ranked targets. System targets suggest `run_analysis_layer` with `agent-fast-refresh` because default CAS requires AI system/capability summaries; capability, service, node, entity, and entry-point targets suggest `generate_element_description` with `target`, `target_kind`, and behavior-level description instructions.

### `generate_element_description`

Manually generate and store an AI description for one CAS element. Use this for drilldown descriptions after the fast default analysis has completed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute path to the analyzed project directory |
| `target` | string | yes | Element id or name |
| `target_kind` | string | no | `node`, `service`, `entity`, `capability`, `entry_point`, or `exit_point` |
| `instructions` | string | no | Optional audience/emphasis guidance |

**Returns:** Target metadata, AI description, generation timestamp, and storage status. The description is written back into the local analysis and to the per-project description store.

### `get_element_description`

Fetch a stored manual AI description and report whether source changes invalidated it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute path to the analyzed project directory |
| `target` | string | yes | Element id or name |
| `target_kind` | string | no | Optional target kind to disambiguate |

**Returns:** `valid`, `missing`, or `invalidated` plus the stored description and invalidation reason when applicable.

### `get_analysis_phases`

Inspect which analysis layers completed, which were deferred, and what each layer contributes to UI visualization and AI-agent development.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute path to the analyzed project directory |

**Returns:** Analysis id/timestamp, phase status records, AI description status for the system narrative and top capabilities, and `enrichment_targets` for the next weak system/capability descriptions to regenerate.

### `run_analysis_layer`

Manually trigger one focused Klauro layer without running the whole default agent workflow.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute path to the analyzed project directory |
| `layer` | string | yes | `agent-fast-refresh`, `ui-overview-refresh`, `deep-context-refresh`, `manual-element-description`, or `runtime-simulation` |
| `target` | string | for descriptions | Element id/name for `manual-element-description` |
| `target_kind` | string | no | Element kind for `manual-element-description` |
| `instructions` | string | no | Description guidance |
| `scenario` | string | no | Runtime simulation scenario |
| `event_count` | number | no | Runtime simulation event count |
| `seed` | string | no | Stable runtime simulation seed |
| `persist` | boolean | no | Store runtime simulation observations |
| `force_full` | boolean | no | Force full rebuild for refresh layers |

**Returns:** The layer-specific result. Refresh layers return analysis counts and phase records; manual descriptions return stored AI description metadata; runtime simulation returns mapped observations and operational priorities.

### `initialize_klauro_project`

Write `.klaurorc` and `.klauroignore` so teams can control analyzer mode, upload policy, source include/exclude rules, and project identity.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute path to the project directory |
| `mode` | string | no | `local` or `remote` analyzer mode |
| `server_url` | string | no | Remote analyzer URL |
| `project_id` | string | no | Stable hosted project id |
| `organization_id` | string | no | Hosted organization id |
| `force` | boolean | no | Overwrite existing config files |

**Returns:** Written config paths, analyzer mode, analyzer URL, project id, and organization id.

### `get_klauro_project_config`

Read the effective `.klaurorc`, `.klauroignore`, analyzer mode, upload policy, source rules, and project identity.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute path to the project directory |

**Returns:** Config file path, ignore file path, ignore patterns, and merged config.

### `get_upload_manifest`

Dry-run the upload policy and show exactly which files would be sent before shared committed-source analysis or private dirty-tree context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute path to the project directory |
| `dirty_tree` | boolean | no | Show private dirty-tree working-copy context instead of committed-source upload |

**Returns:** Included files, byte counts, excluded sample, config path, ignore path, branch/commit status, workspace recommendations, and the recommended next action.

### `get_agent_revision_tracks`

Return the three-track agent state for a local repository.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute path to the project directory |
| `server_url` | string | no | Klauro API/analyzer URL. Defaults to Klauro Cloud |
| `analysis_id` | string | no | Stable project analysis id. Defaults to configured project id or a hash of the local project path |

**Returns:** Working track for private uncommitted changes, committed track for the local selected-branch commit and whether it has shared analysis, and incoming track for analyzed commits from teammates/provider pushes that are not local HEAD.

### `get_github_import_plan`

Describe the GitHub App permissions, webhooks, and local-agent handoff needed for hosted selected-branch analysis.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute path to the project directory |

**Returns:** Required GitHub App permissions, webhooks, configured owner/repositories, and note about private working-copy context.

### `analyze_codebase_remote`

Upload a filtered committed-source snapshot to a remote Klauro analyzer service, cache the returned CAS locally, and record a shared project analysis revision.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute path to the project directory |
| `server_url` | string | no | Analyzer service URL. Defaults to `KLAURO_ANALYZER_URL` or Klauro Cloud |
| `analysis_id` | string | no | Stable remote analysis id. Defaults to a hash of the local project path |

**Returns:** Status, remote analysis id, revision, analysis type, upload size, and CAS graph counts.

### `sync_codebase_remote`

Send dirty-tree file changes to a remote Klauro analyzer service for private local agent assistance. This is not shared project truth and should not be visible to teammates.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute path to the project directory |
| `server_url` | string | no | Analyzer service URL. Defaults to `KLAURO_ANALYZER_URL` or Klauro Cloud |
| `analysis_id` | string | no | Stable remote analysis id. Defaults to a hash of the local project path |

**Returns:** Status, remote analysis id, revision, analysis type, changed file count, upload size, graph counts, and incremental change summary.

### `preview_codebase_iteration`

Analyze an agent proposal as an ephemeral iteration of an existing codebase. This does not change CAS semantics: Klauro copies the codebase, applies the proposed diff/files in the copy, runs normal CAS analysis, compares baseline and proposed analyses, and stores a product-level preview artifact.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Absolute path to the existing project directory |
| `plan_text` | string | yes | Natural-language proposal or agent plan |
| `title` | string | no | Human-readable preview title |
| `diff_text` | string | no | Unified diff to apply in the temporary workspace |
| `proposed_files` | array | no | Explicit file additions/modifications/deletions |
| `organization_id` | string | no | Hosted organization/workspace id for private preview URL |
| `project_id` | string | no | Hosted project id |
| `codebase_id` | string | no | Hosted codebase id |
| `preview_base_url` | string | no | Hosted Klauro app base URL |

**Returns:** Advisory status, preview id, private preview URL, baseline/proposed analysis ids, graph delta, changed contracts, idiom/invariant validation output, required checks, and visualization summary.

### `preview_greenfield_codebase`

Analyze proposed files as a synthetic new codebase. The output is still normal CAS; the proposal preview artifact only references the proposed analysis and visualization payload.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `plan_text` | string | yes | Natural-language proposal or agent plan |
| `title` | string | no | Human-readable preview title |
| `proposed_files` | array | yes | Proposed file bundle for the synthetic codebase |
| `organization_id` | string | no | Hosted organization/workspace id for private preview URL |
| `project_id` | string | no | Hosted project id |
| `preview_base_url` | string | no | Hosted Klauro app base URL |

**Returns:** Advisory status, preview id, private preview URL, proposed analysis id, detected graph summary, required checks, and greenfield readiness warnings.

### `get_greenfield_architecture_guidance`

Use existing analyzed repositories as memory before creating a new codebase. Answers "has something like this already been built here" before an agent starts a greenfield slice.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `plan_text` | string | yes | Natural-language new-project goal or agent plan |
| `proposed_files` | array | no | Optional proposed file bundle (`path`, `content`, `status`: `added`/`modified`/`deleted`) to review before `preview_greenfield_codebase` |
| `reference_paths` | string[] | no | Existing analyzed repositories to use as memory. Omit to use all stored analyses |
| `limit` | number | no | Maximum overlap matches to return |

**Returns:** Architecture options, duplicate-capability warnings drawn from the reference repositories, first-file guidance, suggested tests, and next MCP preview steps.

### `get_greenfield_build_context`

Guide a zero-repo or growing greenfield build. This is the MCP surface agents should use when the user asks for a new project that does not have a repository yet, or when a new project already has an initial slice and the agent needs to continue without duplicating architecture or domain concepts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workspace_path` | string | yes | Absolute path to the empty or growing project folder |
| `plan_text` | string | yes | Current product requirement or next-slice plan |
| `proposed_files` | array | no | Optional proposed file bundle for the next slice |
| `reference_paths` | string[] | no | Existing analyzed repositories to use as external memory |
| `limit` | number | no | Maximum overlap matches to return |

**Returns:** Stage (`empty_workspace_first_slice` or `continuation_iteration`), current CAS-backed graph memory when files exist, architecture memory with model/boundary/test ownership, `product_focus` guidance for what the agent can now concentrate on, a `growth_control_plane` with product-slice stop rules, architecture budget, concept ownership contract, duplication gate, and next Klauro loop, `agent_build_capsule` in compact `G1` format, concepts/capabilities to reuse, duplicate-prevention rules, focused files to read, next files to create/update, validation checks, risks, and the next MCP calls. Agents should read G1 before injecting expanded greenfield JSON.

### `get_preview_analysis`

Fetch a stored proposal preview artifact.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `preview_id` | string | no | Preview id. Defaults to latest |

**Returns:** Preview metadata, baseline CAS when present, proposed CAS, comparison payload, and visualization payload.

### `compare_analysis_iterations`

Compare two ordinary CAS analyses, or return the comparison for a preview. This is useful outside proposals too: any two analyzed iterations can be compared.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `preview_id` | string | no | Existing preview id to compare |
| `baseline_path` | string | no | Path for baseline stored analysis |
| `proposed_path` | string | no | Path for proposed stored analysis |
| `diff_text` | string | no | Optional diff used to focus impact checks |
| `files` | string[] | no | Optional changed files used to focus impact checks |

**Returns:** Graph delta, changed contracts, impacted files, required checks, idiom validation, and behavioral invariant validation.

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

### `get_storage_maintenance_report`

Dry-run report for generated Klauro storage and allowlisted temp proof/preview/live-trial artifacts. This tool never deletes files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `root` | string | no | Klauro home root. Defaults to `~/.klauro` |
| `repo_root` | string | no | Repository root when `include_local_artifacts` is true |
| `temp_root` | string | no | Temp root when `include_temp_artifacts` is true. Defaults to the OS temp directory |
| `older_than_days` | number | no | Select generated artifacts older than this many days |
| `max_bytes` | number | no | Also select oldest/largest artifacts until generated storage is under this byte limit |
| `include_local_artifacts` | boolean | no | Include repo-local `.klauro-*` benchmark artifacts under `repo_root` |
| `include_temp_artifacts` | boolean | no | Include allowlisted Klauro-generated temp proof/preview/live-trial workspaces |
| `include_analyses` | boolean | no | Include analysis snapshot files. Off by default |

**Returns:** Dry-run prune report with scanned categories, candidate count, reclaimable bytes, candidate paths, and delete status set to dry-run.

### `prune_storage_artifacts`

Delete selected generated Klauro artifacts. This is guarded: it requires `confirm_delete=true`, and it only deletes allowlisted generated artifacts selected by the provided filters. Call `get_storage_maintenance_report` first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `confirm_delete` | boolean | yes | Must be true to delete selected generated artifacts |
| `root` | string | no | Klauro home root. Defaults to `~/.klauro` |
| `repo_root` | string | no | Repository root when `include_local_artifacts` is true |
| `temp_root` | string | no | Temp root when `include_temp_artifacts` is true. Defaults to the OS temp directory |
| `older_than_days` | number | no | Select generated artifacts older than this many days |
| `max_bytes` | number | no | Also select oldest/largest artifacts until generated storage is under this byte limit |
| `include_local_artifacts` | boolean | no | Include repo-local `.klauro-*` benchmark artifacts under `repo_root` |
| `include_temp_artifacts` | boolean | no | Include allowlisted Klauro-generated temp proof/preview/live-trial workspaces |
| `include_analyses` | boolean | no | Include analysis snapshot files. Off by default |

**Returns:** Prune report with deleted paths, reclaimed bytes, scanned categories, and remaining dry-run status false.

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

**Returns:** `system`, `architecture_summary`, `system_health`, `system_purpose`, `enhanced_system_purpose`, `analysis_phases`, `system_capabilities`, `progressive_levels`, `analyzer_contributions`, `analysis_errors`, `configuration`, `runtime`, `repository_links`, `runtime_static_links_count`, `analysis_facts_count`, `disclosure`, `validation`.

### `get_architecture_context`

Compact architecture guidance for agents before planning or editing. Use this
when the task may touch placement, boundaries, new files, refactors, or pattern
choice.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `target` | string | no | Optional node, file, or feature target |
| `files` | string[] | no | Optional changed/planned files |
| `limit` | number | no | Maximum patterns to include |

**Returns:** `system_type`, compact `architecture_budget`, detected
`patterns` with confidence and guidance, inventory counts and examples for
models, views, controllers, view models, services, repositories, clients,
mediators, unit-of-work, singletons, scripts, and packages, target-relevant
inventory nodes, `pattern_decision_matrix` entries that tell agents when to use
MVC/MVVM/repository/service/mediator/unit-of-work/singleton patterns and which
owner categories/examples to follow, `pattern_balance`, and agent rules for
preserving local architecture.

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

### `run_workspace_analysis`

Build and persist a workspace-level CAS (a parent CAS composing its member repos' CAS analyses) from completed CAS analyses only. Workspace analysis is generated after repo/project analysis; it composes projects, deployables, interfaces, runtime topology, deployable links, data-flow paths, unmatched interfaces, deterministic insights, health, risk, activity, telemetry, workspace domains, and AI-required narrative without reading source code in the workspace layer. When `workspace_root` is provided, `.klauroignore`, `.klaurorc` `source.exclude`, and explicit `exclude` patterns are applied before workspace-level CAS input selection so intentionally ignored folders do not become projects, deployables, or links.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | no | Workspace analysis name, default `analyzed-workspace` |
| `paths` | string[] | no | Analyzed project paths to include. Omit to use all analyzed repositories |
| `workspace_root` | string | no | Workspace folder used to select analyzed repos under the root and apply local `.klaurorc` / `.klauroignore` policy |
| `exclude` | string[] | no | Additional workspace exclude patterns, e.g. `["desktop-tray/**", "archives/**"]` |
| `ai_enrichment` | boolean | no | Defaults to `true`. Set `false` for fast deterministic workspace-level CAS generation; narrative is marked AI-required degraded until refreshed |

**Returns:** Save metadata, compact workspace-level-CAS summary, applied input policy, skipped inputs with reasons, and next MCP calls. Agents should retrieve needed slices with `get_workspace_analysis` or `get_workspace_agent_context`; this tool does not dump the full workspace-level CAS artifact.

### `resolve_workspace_analysis`

Find the best persisted workspace-level CAS for a local path or set of paths. Use this before cross-repo work when the agent has a workspace folder but does not know the Workspace analysis id.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | no | Workspace, repo, or subfolder path to resolve |
| `paths` | string[] | no | Optional set of repo/workspace paths to match against workspace-level CAS inputs |

**Returns:** Selected Workspace analysis id/name, composition, health, freshness, alternatives, and recommended next MCP calls.

### `get_workspace_summary`

Return a compact human/agent summary from the workspace-level CAS.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `analysis_id_or_name` | string | yes | Workspace analysis id or name |

**Returns:** AI-required workspace narrative status, composition, health, freshness, workspace domains, primary capabilities, workflows, risk areas, activity, and telemetry.

### `get_workspace_analysis`

Load a persisted workspace-level CAS by id or name.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `analysis_id_or_name` | string | yes | Workspace analysis id or name |
| `detail_level` | string | no | `overview`, `connections`, `evidence`, or `full`. Defaults to `overview` |

**Returns:** At `overview`, a compact repo/app map with composition classification, health, activity, telemetry, risks, capabilities, workflows, environments, simple sync/async/passive/stream connections, major external dependencies, and isolated deployables. `composition.kind` tells clients whether the workspace is primarily an `interconnected-system`, `composed-application-architecture`, `hybrid-system-and-architecture`, `library-collection`, or `disconnected-collection`; `recommended_primary_view` tells agents/UI whether to prefer a system map, architecture map, both, or inventory. External dependencies include `usage` (`source-backed`, `topology-only`, or `declared`) and `used`; agents should treat `topology-only` Redis/Postgres/MinIO/etc. as provisioned/wired infrastructure, not source-proven usage. Isolated deployables include a reason category (`validated-standalone`, `weak-cas-signal`, `unresolved-candidate`, or `no-evidence`) so agents do not confuse valid standalone surfaces with possible analysis gaps. Deeper levels add links, runtime evidence, interfaces, unmatched surfaces, validation, Terraform/Docker/Compose/CI infrastructure details, or the complete graph. At `full` (and `evidence`) detail, the graph also carries `shared_code_rollup` (`WorkspaceSharedCodeRollup[]`, not a separate tool) — cross-deployable shared-library rollups built from `libs/*`-style code recognized in deployable detection, composed from SDK-install links + CAS import specifiers: for each shared library, its consumer deployables, the consumed-symbol surface, and per-symbol blast radius, so a monorepo's `libs/`/shared-package surfaces are queryable instead of structurally invisible to the workspace-level CAS.

### `get_workspace_agent_context`

Load a compact workspace-level-CAS-backed context for cross-repo agent work. This is the preferred agent entrypoint after `run_workspace_analysis` when a task spans multiple repos, apps, deployables, SDKs, messages, runtime dependencies, or infrastructure.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `analysis_id_or_name` | string | yes | Workspace analysis id or name |
| `task` | object | no | Task selector with `task_type`, `target`, `instructions`, `max_apps`, `max_connections`, and `max_external_dependencies` |

**Returns:** Composition classification, selected workspace surfaces with stable ids, explicit `deployable` flags, `surface_kind`, and absolute project paths; source-backed runtime connections with stable ids/interface ids; candidate/package/topology connections with `runtime_behavior`, `connection_nature`, and `inferred_reason`; source-backed/topology-only/declared external dependencies; isolated surfaces; compact system summary; health/risk/activity/telemetry/capability/workflow context; token-budget estimate and signal quality; validation guidance; `agent_should_read_next`; and next MCP calls. Agents should use this before broad multi-repo source exploration, then call repo-level `get_agent_context` for each selected project before editing. If `workspace_narrative.source` is `ai-required-degraded`, the artifact is usable for evidence but should be refreshed with AI enrichment before customer-facing interpretation.

### `get_workspace_freshness`

Check whether a persisted workspace-level CAS is current against its input CAS analyses.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `analysis_id_or_name` | string | yes | Workspace analysis id or name |

**Returns:** Fresh/stale/unknown status, stale input list, and checked input count.

### `validate_was_contract`

Score a persisted workspace-level CAS for required sections, freshness, required AI enrichment, and relationship evidence readiness.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `analysis_id_or_name` | string | yes | Workspace analysis id or name |

**Returns:** Pass/warn status, score, missing sections, AI enrichment status, freshness, and embedded workspace-level-CAS validation.

### `get_workspace_health`

Return workspace health and priority work items.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `analysis_id_or_name` | string | yes | Workspace analysis id or name |

**Returns:** Health, activity, telemetry, priority work items, and top risk areas.

### `get_workspace_risk_context`

Return workspace risks filtered by target or severity.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `analysis_id_or_name` | string | yes | Workspace analysis id or name |
| `target` | string | no | Optional project/deployable/interface/risk text filter |
| `severity` | string | no | `critical`, `high`, `medium`, or `low` |
| `limit` | number | no | Maximum risks |

**Returns:** Focused risk areas with evidence and next MCP calls.

### `get_workspace_capability_map`

Return whole-workspace domains, capabilities, and workflows.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `analysis_id_or_name` | string | yes | Workspace analysis id or name |
| `target` | string | no | Optional capability/domain/workflow text filter |
| `limit` | number | no | Maximum records per section |

**Returns:** Workspace domains, primary capabilities, and workflows with project/deployable ids, description provenance, and evidence.

### `get_workspace_entity_map`

Return whole-workspace entity concepts and entity paths assembled from repo-level CAS entities, data lineage, workflows, capabilities, and cross-repo flows. This is an index and drilldown guide; repo-local entity details remain in CAS.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `analysis_id_or_name` | string | yes | Workspace analysis id or name |
| `target` | string | no | Optional entity, project, workflow, capability, field, or service text filter |
| `include_paths` | boolean | no | Include entity paths. Defaults to `true` |
| `limit` | number | no | Maximum entities/paths |

**Returns:** Workspace entity concepts, entity paths, sensitive-field hints, lifecycle counts, and repo-level `get_data_lineage` drilldown calls.

### `get_workspace_workflow`

Return a specific workspace-level-CAS workflow with deployables, interfaces, evidence, and repo-level drilldown calls.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `analysis_id_or_name` | string | yes | Workspace analysis id or name |
| `workflow_id_or_name` | string | yes | Workflow id or name |

**Returns:** Workflow, connected deployables, connected interfaces, and repo-level `get_agent_context` calls.

### `list_workspace_analyses`

List persisted workspace-level CAS analyses.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | | | |

**Returns:** Array of Workspace analysis metadata with id, name, timestamps, project count, deployable count, integration-link count, and storage file.

### `run_cross_codebase_analysis`

Deprecated name for `run_workspace_analysis`. Same behavior and parameters -- builds a workspace-level CAS from completed CAS outputs. Kept for backward compatibility; prefer `run_workspace_analysis`.

### `get_cross_codebase_analysis`

Deprecated name for `get_workspace_analysis`. Same behavior and parameters -- loads a persisted workspace-level CAS by id or name. Kept for backward compatibility; prefer `get_workspace_analysis`.

### `list_cross_codebase_analyses`

Deprecated name for `list_workspace_analyses`. Same behavior and parameters. Kept for backward compatibility; prefer `list_workspace_analyses`.

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

High-level payload for Codex, Claude, Cursor, and other coding agents after `resolve_agent_analysis` has selected the analysis path.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `task` | object | no | Optional task context with `task_type`, `target`, `related_paths`, or `runtime_event` |

**Returns:** Agent-use rule, agent readiness, start context, task-specific tool plan, agent context, source file read plan, and a ready-to-use prompt. This is the highest-level agent bootstrap surface.

### `get_agent_project_map`

List analyzed parent and subproject candidates for a repository path. Use this when an agent is handed a monorepo/root path and needs to know which stored analyses are available before broad source reads.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | no | Repository or subproject path to filter candidates. Omit to map all stored analyses |
| `task` | object | no | Optional task context with `task_type`, `target`, `related_paths`, `runtime_event`, `instructions`, or `success_criteria` |
| `limit` | number | no | Maximum candidates to return |

**Returns:** Requested path, candidate analyses, relation to the requested path (`exact`, `descendant`, `ancestor`, or `other`), readiness/agent-context-ready status, analysis profile, graph counts, target matches, selected candidate, and routing rule.

### `resolve_agent_analysis`

Select the best stored CAS analysis for an agent task. This is the default first call when the handed path might be a monorepo, workspace, or repository root with stronger subproject analyses.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Repository or subproject path the agent was handed |
| `task` | object | no | Optional task context with `task_type`, `target`, `related_paths`, `runtime_event`, `instructions`, or `success_criteria` |

**Returns:** Selected path, selected candidate profile/readiness, alternatives, and a recommendation. Use `selected_path` for `get_agent_start_context`, `get_agent_tool_plan`, `get_agent_context`, and follow-up tools when it differs from the requested path.

### `get_agent_start_context`

Default first call for Codex, Claude, Cursor, and other coding agents when an analysis exists. Returns the CAS-backed orientation an agent needs before broad file reads.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `task` | object | no | Optional task context with `task_type`, `target`, `related_paths`, or `runtime_event` |

**Returns:** Agent-use rule, agent readiness status, system summary, scale metrics, top entry/exit points, connected nodes, runtime links, answer-pack status, recommended first MCP tools, and guidance for when source file reads are still required.

### `get_agent_tool_plan`

Task-specific MCP call plan for agents. Use this before choosing source files so CAS narrows the work area first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `task` | object | no | Optional task context. `task_type` supports `orient`, `modify`, `debug`, `review`, `trace`, `cross-repo`, and `runtime`; `instructions` and `success_criteria` preserve the user's exact behavioral ask |

**Returns:** Ordered MCP steps with tool names, arguments, purpose, required/optional status, and fallback behavior if CAS/MCP is missing or stale.

### `get_agent_context`

Task-scoped context for agents. Use this after `get_agent_start_context` when an agent needs codebase context for the work it is about to do without manually orchestrating every query. Klauro does not decide the task; it returns the relevant system facts, risks, conventions, files, and validation context for the agent's own intent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `workspace_analysis_id` | string | no | Optional workspace-level CAS id/name to include compact workspace context alongside repo CAS context |
| `task` | object | no | Optional task context with `task_type`, `target`, `related_paths`, `runtime_event`, `instructions`, `success_criteria`, or `response_profile` |

**Returns:** Target resolution, selected node, coding context, `capability_memory` for avoiding duplicate/rebuilt behavior, change risk, callers, callees, tests, error contracts for debug tasks, behavioral invariant impact, compact `idiom_context`, optional workspace-level-CAS `workspace_context`, runtime-backed `operational_priorities` for debug/runtime/production-symptom tasks when telemetry exists, representative entry/call-chain context, recommended MCP follow-ups, adoption gaps, a file read plan with concrete source files, bounded line windows, and reasons, an `execution_brief` plus `execution_brief.capsule` for token-minimal first implementation, and a validation plan with focused test/typecheck/build commands, monorepo package script routing, tests to inspect, manual checks, environment rules, and validation gaps.

Set `task.response_profile` to `capsule-only` when an agent needs the smallest useful starting context. It returns only the `K15` context capsule, `K5` execution capsule, selected target, first files, token estimate, and expansion rule. Set `first-turn` when the agent needs compact JSON fields in addition to the capsules. `K5` includes exact file paths, read/edit role sigils, file-scoped operations for direct-patch work, proof requirements, negative constraints, preservation rules, validation, and stop cues. `K15` is the compact agent context language for orientation, selected node, default extension restoration, role-grouped file dictionary, idioms, reuse, risk, validation, and expansion rules. Set `minimal` when the agent needs compact architecture/risk/test context, or omit it for the full agent context. For edit/debug tasks where token savings matter, agents should read `context_capsule` / `context_capsule.capsule` for orientation, execute `execution_capsule` / `capsule` before opening any other files, then fall back to `first-turn` or full workbench only if the capsules are ambiguous.

### `get_capability_memory`

Find existing analyzed capabilities that overlap the requested work so agents avoid rebuilding behavior that already exists.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `target` | string | no | Capability, file, node, route, domain, or user-requested feature to compare against existing CAS capabilities |
| `instructions` | string | no | Task or plan text to match against existing capabilities |
| `success_criteria` | string[] | no | Expected outcomes to include in overlap matching |
| `files` | string[] | no | Known files involved in the work |
| `limit` | number | no | Maximum capabilities to return |

**Returns:** A compact capability-memory context with matched capabilities, overlap scores, operation paths, related entities/domains, reuse decisions, do-not-rebuild guidance, and first checks for agents before adding new services, routes, workers, models, packages, or duplicated behavior.

### `get_idiom_aware_agent_context`

Task-scoped agent context with top-level idiom context for clients that want repo-local conventions first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `workspace_analysis_id` | string | no | Optional workspace-level CAS id/name to include compact workspace context |
| `task` | object | no | Optional task context with `task_type`, `target`, `related_paths`, `runtime_event`, `instructions`, or `success_criteria` |

**Returns:** The normal agent context plus top-level `idiom_context` with selected idioms, local examples, do/avoid guidance, validation instructions, and likely violations.

### `open_agent_workbench`

Product-level agent workspace for a task. Use this before broad source exploration when an agent needs one task-scoped context surface instead of stitching together many lower-level calls.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `workspace_analysis_id` | string | no | Optional workspace-level CAS id/name to include compact workspace context |
| `task` | object | no | Optional task context with `task_type`, `target`, `instructions`, `success_criteria`, `change_type`, `files`, `diff_text`, or `plan_text` |

**Returns:** Orientation, target resolution, file-read plan, validation plan, repo-local agent rules, `signal_quality`, evidence policy, stop conditions, and next MCP calls. `signal_quality` tells the agent when tests, patterns, idioms, invariants, purpose confidence, or analyzer coverage are thin so the context is treated as guidance instead of complete truth.

### `preflight_agent_change`

Before an agent edits or presents a plan, evaluate whether the proposed change fits the current codebase model.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `workspace_analysis_id` | string | no | Optional workspace-level CAS id/name for cross-repo blast-radius context |
| `target` | string | no | Node id, file path, or natural language target |
| `plan_text` | string | no | Agent plan text to evaluate |
| `diff_text` | string | no | Unified diff to evaluate |
| `files` | string[] | no | Changed or proposed files |
| `task` | object | no | Optional task context |

**Returns:** Advisory verdict, change shape, target resolution, likely risk/idiom/invariant/test impacts, findings, `signal_quality`, required checks, and a `plan_output_block` agents can include in user-facing plans. Findings include `evidence_source` so clients can distinguish CAS-backed facts from plan-text heuristics.

### `get_codebase_agent_rules`

Generate a living, CAS-backed guide for how agents should work in this repository.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `target` | string | no | Optional node id, file path, or natural language target |
| `files` | string[] | no | Optional files to focus the rules |
| `limit` | number | no | Max idioms/invariants to include |

**Returns:** Architecture rules, idiom rules, invariant rules, testing rules, source-reading rules, evidence counts, `signal_quality`, and confidence notes.

### `explain_change_shape`

Explain what a proposed or actual diff means in graph terms.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `target` | string | no | Optional target node id, file path, or natural language target |
| `plan_text` | string | no | Optional plan text |
| `diff_text` | string | no | Optional unified diff |
| `files` | string[] | no | Changed or proposed files |

**Returns:** Changed source/test/migration/schema files, inferred change scope, touched CAS nodes, affected tests, affected idioms, affected invariants, `signal_quality`, confidence notes, and a compact narrative explanation.

### `validate_agent_change`

Post-edit validation for agents. Use before finalizing a change.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `target` | string | no | Optional node id, file path, or natural language target |
| `diff_text` | string | no | Optional unified diff to validate |
| `files` | string[] | no | Optional changed files; when omitted, the working tree is used |
| `include_working_tree` | boolean | no | Validate git working tree when no explicit files/diff are supplied |
| `plan_text` | string | no | Optional original plan text |

**Returns:** Combined idiom and behavioral-invariant validation, change shape, findings with `evidence_source`, `signal_quality`, required checks, advisory verdict, and an advisory finalization rule. Treat `does_not_fit_yet` as a strong “review before finalizing” signal, not as a replacement for tests or human/agent judgment.

### `evaluate_agent_readiness`

Score whether this repository's CAS/MCP surface is good enough for agents to use by default.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Pass/warn/fail status, score, `agent_context_ready` boolean, graph and answerability gates, adoption gaps, and the required agent behavior contract.

### `get_agent_doctor`

Run the agent-context-ready readiness doctor for Codex, Claude, and other coding agents. This combines CAS contract validation, analysis freshness, test discovery evidence, runtime SDK proof, and golden snapshot status into one payload.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Pass/warn/fail status, `agent_context_ready` boolean, readiness report, freshness report, test discovery evidence, runtime event contract, runtime SDK package proof, golden snapshot comparison, and recommended first MCP tools.

### `get_server_version`

Diagnostic: report the running Klauro MCP server's version and whether a newer build is available. Call this FIRST whenever a tool you expect (from docs, a changelog, or another agent's output) appears to be missing — that almost always means the MCP connection is a stale/pre-release build, not that the feature does not exist. Always available, requires no analysis, never throws.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `server_url` | string | no | Override for the release-manifest host. Defaults to the stored login server, `KLAURO_URL`, or the public Klauro cloud URL |

**Returns:** `current_version`, `latest_version` (or `null` if the manifest was unreachable), `up_to_date`, `update_command` (`klauro update`), and a `note` explaining the status -- including a reminder that the MCP client must be restarted after updating since MCP servers do not hot-reload.

### `get_agent_default_config`

Return install-ready agent-context-ready instructions for an agent without writing files.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `task` | object | no | Optional task context |

**Returns:** Required agent rule, MCP server command, first calls, prompt text, doctor output, and bootstrap output.

### `install_agent_default_config`

Write `.klauro/agent-defaults.json`, `.klauro/agent-defaults.md`, and `.klauro/skills/klauro/SKILL.md` into a repository.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `task` | object | no | Optional task context |

**Returns:** The installed config and file paths. Agents can read these files to use Klauro as the default first context path, or install the generated skill into Claude, Codex, or another skill-aware agent.

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

**Returns:** Scores and evidence for jobs, brokers, auth, payments, AI SDKs, infrastructure, observability, cache, and persistence, including found surfaces, missing extracted surfaces, unobserved optional surfaces, and recommended analyzers.

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

Run agent contexts for representative tasks and score whether CAS gives enough target, risk, test, MCP, and file-read context to begin work.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `tasks` | object[] | no | Agent tasks to evaluate |

**Returns:** Per-task scores, selected nodes, file read plans, and gaps.

### `run_agentic_benchmark`

Benchmark the same task with Klauro vs without Klauro.

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
| `benchmark_type` | string | no | Restrict `latest` or `list` to an exact benchmark type such as `agentic-suite-with-klauro-vs-without-klauro`, `deterministic-agent-quality-proxy`, `live-agent-quality-ab`, `live-agent-idiom-quality-ab`, or `incremental-analysis-agent-value` |
| `list` | boolean | no | List reports instead of loading one |

**Returns:** Report list or one report with Markdown rendering matched to the stored report type.

### `get_agent_performance_proof`

Summarize persisted benchmark reports into the current evidence that Klauro helps agents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `benchmark_types` | string[] | no | Exact benchmark types to include; omit for all persisted benchmark types |
| `max_reports` | number | no | Maximum persisted reports to inspect before grouping by latest benchmark type |
| `since_days` | number | no | Only include reports generated within this many days; defaults to 7, use 0 for all persisted reports |

**Returns:** Latest recent reports by benchmark type, live A/B rollups, proof claims, compact metrics, and Markdown suitable for an agent or reviewer.

### `run_agent_quality_benchmark`

Run the work-quality benchmark layer on top of the agentic benchmark suite.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `paths` | string[] | no | Project paths to benchmark. Omit to use all analyzed repositories |
| `task` | object | no | Single task to hand to both agents. Supports `task_type`, `target`, `instructions`, `success_criteria`, `related_paths`, and `runtime_event`; omit to generate a task suite |
| `max_tasks_per_repo` | number | no | Maximum generated suite tasks per repository |
| `agent_with_command` | string | no | Live with-Klauro command template. Supports `{workspace}`, `{prompt_file}`, `{metrics_file}`, `{result_file}`, `{arm}`, and `{task_id}` |
| `agent_without_command` | string | no | Live without-Klauro command template. Supports the same arm placeholders |
| `orchestrator_command` | string | no | Optional evaluator command template. Supports `{evaluation_input}`, `{evaluation_file}`, `{with_workspace}`, `{without_workspace}`, `{with_diff}`, and `{without_diff}` |
| `test_command` | string | no | Optional command to run inside each copied repo after the agent attempt |
| `work_root` | string | no | Directory for copied repos, prompts, diffs, metrics, and evaluator artifacts |
| `max_live_tasks` | number | no | Maximum task pairs to run through live agents |
| `live_task_types` | string[] | no | Only run live pairs for these task types (`modify`, `debug`, `review`, etc.) |
| `live_task_categories` | string[] | no | Only run live pairs for these generated categories (`modify`, `data`, `external`, `test`, etc.) |
| `timeout_ms` | number | no | Per-agent command timeout in milliseconds |
| `test_timeout_ms` | number | no | Per-test command timeout in milliseconds |
| `orchestrator_timeout_ms` | number | no | Evaluator command timeout in milliseconds |

**Returns:** Persisted report metadata, JSON report, Markdown report, success gates, context completeness, projected baseline quality, quality-score delta, token/time/file deltas, and optional live A/B execution results. Live results include copied repo paths, prompt/result/metric files, the with-Klauro agent-context artifact, binary diff paths, changed files, lines added/deleted, raw wall-clock duration, test status, provider token metrics when reported, deterministic orchestrator scores, optional external-orchestrator scores, and separated patch-quality, hidden-validation, command-completion, and timeout signals. The live `time_reduction_percentage` metric is time to valid solution: when one arm produces an invalid diff, the valid arm gets credit for reaching a solution instead of comparing raw wall time for an invalid patch. Claude Code live commands are also classified as lean or full-agent measurement mode; use `--safe-mode --no-session-persistence` on both arms when measuring Klauro token savings so unrelated local memory, plugins, hooks, and session persistence do not mask context savings. When using `--add-dir {workspace}`, put `--` before `"$(cat {prompt_file})"` so Claude does not treat the prompt as another allowed directory.

### `run_agent_idiom_benchmark`

Run copied-repo A/B idiom quality tasks. Both arms receive the same task; the with-Klauro arm receives CAS idiom context and the without-Klauro arm is prohibited from using CAS/MCP/precomputed agent contexts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `paths` | string[] | no | Project paths to benchmark. Omit to use all analyzed repositories |
| `max_targets` | number | no | Maximum repositories to benchmark |
| `max_tasks_per_repo` | number | no | Maximum idiom tasks per repo |
| `agent_with_command` | string | no | Live with-Klauro command template |
| `agent_without_command` | string | no | Live without-Klauro command template |
| `orchestrator_command` | string | no | Optional external evaluator command template |
| `test_command` | string | no | Optional validation command inside each copied repo |
| `work_root` | string | no | Directory for copied repos, prompts, diffs, metrics, and evaluator artifacts |
| `max_live_tasks` | number | no | Maximum live task pairs |
| `timeout_ms` | number | no | Per-agent timeout |
| `test_timeout_ms` | number | no | Per-test timeout |
| `orchestrator_timeout_ms` | number | no | Evaluator timeout |

**Returns:** Persisted report metadata, JSON report, Markdown report, per-arm scores for correctness, idiom conformance, minimality, test relevance, boundary preservation, file targeting, token/time deltas when available, and live artifacts when commands are supplied.

### `run_machine_agent_proof`

Discover every real Git repo under a dev root, account for unsupported/skipped repos, and run analysis/readiness/idiom/incremental/live proof gates for eligible repos. Use `mode="fast"` for normal local development and `mode="full"` for release/perfection proof. Fast mode still reports every discovered repo, but analyzes only a bounded eligible sample with resource budgets.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dev_root` | string | no | Root to discover Git repos under; default `~/dev` |
| `mode` | `fast` \| `full` | no | `fast` samples eligible repos with source-file and timing budgets; `full` analyzes every eligible repo. Default `fast` |
| `max_targets` | number | no | Limit eligible repos for expensive checks while still reporting all discovered repos |
| `max_source_files` | number | no | Skip eligible repos above this source-file count for expensive checks while still reporting them |
| `work_root` | string | no | Directory for copied repos and benchmark artifacts |
| `no_live` | boolean | no | Skip live idiom A/B execution; live proof gate still fails when skipped |
| `agent_with_command` | string | no | Live with-Klauro agent command template |
| `agent_without_command` | string | no | Live without-Klauro agent command template |
| `orchestrator_command` | string | no | Optional external evaluator command template |
| `test_command` | string | no | Optional copied-repo validation command |
| `max_live_tasks` | number | no | Maximum live idiom task pairs |
| `timeout_ms` | number | no | Per-agent timeout |
| `test_timeout_ms` | number | no | Per-test timeout |
| `analysis_budget_ms` | number | no | Per-selected-repo analysis budget gate; default 30s in fast mode, 120s in full mode |
| `incremental_budget_ms` | number | no | Per-selected-repo edit-incremental budget gate; default 30s in fast mode, 120s in full mode |

**Returns:** Discovery inventory, proof mode and resource policy, selected eligible repo proof rows, unsupported/skipped reasons, incremental benchmark output, idiom benchmark output, and final gates. Acceptance fails if selected repos are omitted, idiom proof is missing, incremental value regresses, resource budgets are exceeded, or live idiom quality lacks a positive delta when live mode is configured.

### `run_incremental_value_benchmark`

Measure whether iterative analysis is fast, correct, and useful after a codebase edit.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `paths` | string[] | no | Project paths to benchmark. Omit to use all analyzed repositories |
| `max_targets` | number | no | Maximum repositories to benchmark |
| `work_root` | string | no | Directory for copied repositories and isolated benchmark storage |
| `verify_full` | boolean | no | Run a fresh full analysis after the edit and compare CAS count parity |
| `discard_workspaces` | boolean | no | Remove copied repositories after collecting results |

**Returns:** Persisted report metadata, JSON report, Markdown report, copied repo paths, edited file, full/no-change/edit-incremental timings, speedups, change summary, incremental state and file-cache counts, optional fresh-full parity, and an agent-context generated from the edited CAS.

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

The `mode` parameter selects the retrieval strategy. The default `hybrid` mode fuses lexical matching with vector similarity and a structural re-rank, so natural-language queries resolve even without lexical overlap. `lexical` is the keyword-only scan. `semantic` is vector-only. When the analysis has no embedding index, `semantic` and `hybrid` fall back to lexical.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `query` | string | yes | Search text (matches name, qualified_name, description). Multi-word queries also match across camelCase/kebab-case/snake_case boundaries |
| `mode` | string | no | Retrieval strategy: `lexical`, `semantic`, or `hybrid` (default `hybrid`) |
| `type` | string | no | Filter by node type (class, function, module, service, controller, etc.) |
| `category` | string | no | Filter by category |
| `level` | number | no | Filter by hierarchy level |
| `limit` | number | no | Max results (default 25) |

**Returns:** Array of `{ id, name, type, qualified_name, category, level, level_name, file, line, description, tags }`.

### `semantic_search`

Natural-language query that returns graph-anchored ranked nodes. Use this for "where do we validate user input" or "the code that sends emails" style questions, where the exact symbol name is unknown. The hybrid query path embeds the query, retrieves vector top-K, fuses with lexical matching via reciprocal rank fusion, and applies a structural re-rank that rewards entry points, high connectivity, and test coverage. Every result is anchored to a CAS node and carries its structural context. Requires an embedding index on the analysis; check `get_embedding_status` first if unsure.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `query` | string | yes | Natural-language description of the code you are looking for |
| `limit` | number | no | Max results (default 25) |
| `type` | string | no | Filter by node type |

**Returns:** Array of `SemanticSearchResult` -- `{ node_id, name, qualified_name, type, framework_role, file, scores: { semantic, lexical, structural, final }, graph_context: { caller_count, callee_count, test_count, is_entry_point, risk } }`.

### `get_embedding_status`

Reports the analysis's semantic embedding index: model, dimensions, document version, store, coverage (embedded, skipped, failed), and `generated_at`, or that no index exists. Use this to confirm semantic retrieval is available and current before relying on `semantic_search` or `search_nodes` in `semantic`/`hybrid` mode.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** The `embedding_index` metadata (`model`, `provider`, `dimensions`, `document_version`, `store`, `generated_at`, `node_count`, `coverage`, `degraded`, `degraded_reason`), or a report that no embedding index is present.

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

### `query_graph`

Cypher-lite query over the code graph. Supports `MATCH (a)[-[:TYPE]->(b)] [WHERE a.field = 'value'] RETURN a|b` -- e.g. `MATCH (a)-[:CALLS]->(b) WHERE b.name = 'save' RETURN a` (callers of `save`), or `MATCH (n) WHERE n.type = 'function' RETURN n`. Queryable fields: `name`, `type`, `id`, `file`, `qualified_name`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `query` | string | yes | Cypher-lite query |
| `limit` | number | no | Max nodes per `RETURN` variable (default 200) |

**Returns:** Matched nodes per requested `RETURN` variable.

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

### `get_interface_signature`

The I/L/S/O contract for one entity in a single call — replaces manually joining `get_entry_points` + `get_exit_points` + `get_data_lineage` + `get_callers`/`get_callees` for the same target. Call this before changing an entity to see its full contract and blast radius in one shot.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `target` | string | yes | Node ID, file path, search query, or `"project"`/`"workspace"` for the aggregate rollup |
| `level` | enum | no | `auto` \| `function` \| `flow` \| `capability` \| `project` \| `workspace` (default: auto-detected from target shape) |
| `caller_limit` | number | no | Max callers in `logic.key_refs` (default 10) |
| `callee_limit` | number | no | Max callees in `logic.key_refs` (default 10) |

**Returns:** Freshness-stamped. `Input` (required parameters / entry points it triggers on), `Logic` (blackbox caller/callee wiring — counts + key refs, honest truncation signal), `Side-effects` (exit points + external data-lineage recipients + boundaries crossed), `Output` (return type / produced entities), and `purpose` (terminal-signal proximity, when reachable). Level-aware: function/flow/capability resolve to one node; project/workspace aggregate from `product_map` + entry/exit points (gaps reported honestly, not fabricated).

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

### `validate_behavioral_invariants`

Validate a working diff, explicit file list, or provided unified diff against CAS behavior-level invariants. Use this after edits and before the final answer when a task may touch tenant/org scope, auth boundaries, authorization, database constraints, migrations, test coverage, data lifecycle, or business rules.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `target` | string | no | Node id, file path, entity, field, or text target |
| `invariant_type` | string | no | Filter by `tenant-scope`, `auth-boundary`, `authorization`, `db-constraint`, `migration-contract`, `test-coverage`, `data-lifecycle`, or `business-rule` |
| `files` | string[] | no | Explicit changed files to validate instead of reading the working tree |
| `diff_text` | string | no | Unified diff text to validate |
| `include_working_tree` | boolean | no | When false, validate only `files` and `diff_text`; default true reads git working-tree and staged changes |
| `limit` | number | no | Maximum impacted invariants to return |

**Returns:** Status, diff source, changed-file summary, impacted invariants with required checks and evidence, failures, warnings, consolidated checks, and next steps. A failure means the agent should fix or report the invariant blocker before claiming the change is complete.

### `get_codebase_idioms`

Repo-local conventions inferred from CAS. Use this before edits when a task needs to match local naming, placement, framework, data, testing, migration, logging, or auth/tenant-scope practices.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `category` | string | no | Filter by `naming`, `file-organization`, `module-boundary`, `dependency-injection`, `data-access`, `error-handling`, `validation`, `auth-tenant-scope`, `logging`, `testing`, `migrations`, `async-style`, or `configuration` |
| `target` | string | no | Node id, file path, or text target |
| `min_confidence` | number | no | Minimum confidence from 0-1 |
| `limit` | number | no | Max results (default 25) |
| `offset` | number | no | Skip first N results |

**Returns:** Idiom summaries with evidence, examples, affected scopes, do/avoid/validation guidance, and known deviations.

### `get_idiom_examples`

Positive examples for a specific idiom, category, or target.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `idiom_id` | string | no | Specific idiom id from `get_codebase_idioms` |
| `category` | string | no | Optional idiom category filter |
| `target` | string | no | Node id, file path, or text target |
| `limit` | number | no | Max results |
| `offset` | number | no | Skip first N results |

**Returns:** Example files, lines, nodes, excerpts, and explanations agents can inspect before editing.

### `validate_codebase_idioms`

Validate a working diff, explicit file list, or provided unified diff against repo-local idioms. Use this after edits and before finalizing alongside `validate_behavioral_invariants`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `target` | string | no | Node id, file path, or text target |
| `category` | string | no | Optional idiom category filter |
| `files` | string[] | no | Explicit changed files to validate instead of reading the working tree |
| `diff_text` | string | no | Unified diff text to validate |
| `include_working_tree` | boolean | no | When false, validate only `files` and `diff_text`; default true reads git working-tree and staged changes |
| `min_confidence` | number | no | Minimum idiom confidence |
| `limit` | number | no | Maximum impacted idioms to return |

**Returns:** Status, changed-file summary, impacted idioms, violations, required checks, and next steps. It flags non-local naming, misplaced files, schema changes without migrations, missing focused tests, generic errors, transient logging, and auth/tenant-scope drift when those idioms exist.

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

### `get_architectural_conflicts`

Architectural self-regulation / cohesion check: is what you're about to build (or what already exists) consistent with how this system is actually built? Call this BEFORE adding non-trivial code to a large system so cohesion is maintained by construction, not caught after the fact.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `severity` | enum | no | Minimum conflict severity to include: `low` \| `medium` \| `high` |
| `limit` | number | no | Max conflicts to return (default 25) |
| `offset` | number | no | Skip first N conflicts (default 0) |

**Returns:** Freshness-stamped. Pattern-conflict/overlap findings (the same concern — e.g. entry-to-repository data access — handled by two competing structural patterns in different places) and engineering-principle violations (layering skips, single-responsibility/ownership breaks, coupling hotspots), each grounded in file/node evidence. `is_cohesive` is true only when there are no conflicts and no error-severity principle violations.

### `get_user_journeys`

Deterministic end-to-end user journeys composed from entry points, call chains, and terminal effects. Each journey shows why a path exists via its terminal entities (e.g. "Create work order -> WorkOrder created").

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `journey_id` | string | no | Specific journey ID for full detail (steps, security boundaries, covering tests) |
| `kind` | string | no | Filter by journey kind: `user-facing`, `system`, or `scheduled` |
| `limit` | number | no | Max results when listing (default 25) |
| `offset` | number | no | Skip first N results (default 0) |
| `format` | string | no | `json` (default) or `markdown` for a human-readable journey brief |
| `include_steps` | boolean | no | Include the compact step chain (`node_id`, `name`, `layer`, `depth`) per journey in the list form (default true) |

**Returns:** With `journey_id`: full journey detail with steps, security boundaries, and covering tests. Without: paginated journey summaries with a human-readable title/headline and the compact step chain per journey.

### `get_paradigm_conformance`

Statistically detected codebase paradigms (service-mediated data access, entry-service-repository layering, guarded HTTP entry points, single-owner entity writes) with adoption rates, evidence files, and file-level deviations. Norms only emerge when at least 70% of comparable code follows the shape, so repos without a norm produce no noise.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `paradigm` | string | no | Specific paradigm name for full detail, e.g. `guarded-http-entry-points` |

**Returns:** With `paradigm`: full detail including every deviation. Without: per-paradigm summaries with up to 3 sample deviations.

### `get_data_lineage`

Deterministic per-entity data lineage: which code writes and reads each data entity, which external services receive it, which security boundaries the data crosses and whether they are guarded, and which user journeys carry it. Entities are ranked by exposure (sensitive fields + unguarded paths + external transfer first).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `entity_id` | string | no | Specific data entity ID for full lineage detail |
| `sensitive_only` | boolean | no | Only return entities with sensitive fields |
| `limit` | number | no | Max results when listing (default 25) |
| `offset` | number | no | Skip first N results (default 0) |

**Returns:** With `entity_id`: full lineage detail for one entity. Without: ranked summaries.

### `diff_behavior`

Behavior-level diff between the current analysis and a prior snapshot: journeys added/removed/changed (matched by entry signature plus terminal entities, not ids), security boundary changes and newly unguarded entries, capability additions and possible duplicates, data lineage exposure changes for sensitive entities, and paradigm deviations introduced or resolved. Risk flags appear first, e.g. a new journey that writes an entity without crossing the auth boundary.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `snapshot` | string | no | Snapshot id to diff against, or `previous` for the most recent prior snapshot (default) |

**Returns:** Journey diffs, security boundary changes, capability diffs, data lineage exposure changes, and paradigm deviation changes, with risk flags surfaced first.

### `get_product_map`

What this codebase actually does, in one call -- read this instead of skimming READMEs and directory trees to orient: system identity, capabilities ordered by criticality and linked to the user journeys and entities they serve, sensitive data and exposure highlights, conventions with open deviations, and health (tests, implementation gaps, top risks), each with coverage caveats so you know what the analysis is sure about.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `section` | string | no | Return only one section: `identity`, `capabilities`, `journeys`, `data`, `conventions`, `health`, or `coverage_caveats` |
| `format` | string | no | `json` (default) or `markdown` for a compact product brief |

**Returns:** The requested section, or the full product map (identity, capabilities, journeys, data, conventions, health, coverage caveats) when `section` is omitted.

### `simulate_runtime_telemetry`

Generate deterministic simulated traffic, errors, latency, and traces mapped onto CAS objects, then feed those observations into operational priorities.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `scenario` | string | no | `balanced`, `bug-hunt`, `traffic-spike`, or `slow-dependencies` |
| `event_count` | number | no | Synthetic observations to generate, max 500 |
| `seed` | string | no | Stable seed for repeatable simulations |
| `persist` | boolean | no | Store generated observations. Defaults to true; set false for dry-run planning |

**Returns:** Simulation id, correlation summary, mapped targets, sample observations, updated operational priorities, and agent guidance. Simulated telemetry is marked in event attributes and should be used for planning and product evaluation until SDK/runtime data exists.

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

**Returns:** Stored runtime observation with generated ID, original event, correlation result, and `source: "ingested"`.

### `ingest_telemetry`

Ingest a batch of real runtime telemetry events in an OTEL-compatible shape. Each event is correlated onto CAS static structure via runtime signals, route matching, file/function hints, and stack frame paths, then stored under the analysis storage directory with `source: "ingested"` in rolling per-day files. See `docs/mcp/TELEMETRY-INGESTION.md` for the full event shape and SDK mapping.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `events` | array | yes | Batch of telemetry events, max 1000 per call |
| `persist` | boolean | no | Store ingested observations. Defaults to true; set false for dry-run correlation |

Each event carries `kind` (`request`, `error`, `log`, `metric`) plus optional `timestamp`, `name`, `service_name`, `environment`, `trace_id`, `span_id`, `parent_span_id`, `method`, `route`, `path`, `status`, `duration_ms`, `function_hint`, `file_hint`, `error` (`type`, `message`, `stack_top_frames`), `volume`, and `attributes`.

**Returns:** Ingestion ID, matched/partial/unmatched correlation counts, matched targets with files and error/volume rollups, top unmatched hints (unmatched events are stored, not dropped), sample observations, and guidance.

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
| `source` | string | no | `ingested` (default), `simulated`, or `all` |
| `limit` | number | no | Max results |

**Returns:** Requested source, ingested/simulated counts, and observations with runtime payloads, CAS correlations, and per-observation `source` provenance. Simulated observations are only returned when explicitly requested.

### `get_operational_priorities`

Rank bugs, bottlenecks, problematic areas, and telemetry-backed work by combining runtime observations with CAS system health, change risk, test gaps, idioms, and static/runtime correlations.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `since` | string | no | ISO timestamp lower bound |
| `include_simulated` | boolean | no | Also include simulated observations (default false) |
| `limit` | number | no | Max priorities |

**Returns:** Prioritized areas with score, severity, per-priority `source` provenance (`ingested`, `simulated`, or `mixed`), matched CAS target, runtime error/latency/volume counts, static risk context, recommendation, and agent guidance. Uses ingested telemetry only by default; when only simulated data exists a note explains how to opt in.

### `get_runtime_trace`

Replay stored runtime observations for a trace ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `trace_id` | string | yes | Runtime trace ID |
| `source` | string | no | `ingested` (default), `simulated`, or `all` |

**Returns:** Ordered observations for the trace, ingested/simulated counts, matched/unmatched counts, and CAS static IDs touched by the trace.

## Multi-Agent Coordination

See [`../SPEC-COORDINATION-FABRIC-V3.md`](../SPEC-COORDINATION-FABRIC-V3.md) for the authoritative model. Fabric enables realtime collaboration over any semantic unit, including the same file, function, flow, capability, entity, or intent. Every participant retains an attributed stream and can continue immediately. Duplicate, overlap, contract-divergence, and conceptual-coherence findings are shared context, never permission decisions or scheduling gates. Local state uses the file-backed claim stream store; cross-machine state, semantic snapshots, and continuous updates use the authenticated HTTP and SSE surfaces.

### `claim_work`

Publish an attributed Fabric stream before starting non-trivial work. Claims over the same path, symbol, flow, step, capability, entity, or intent all succeed immediately and remain independently visible.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workspace` | string | yes | Workspace or project id/path to coordinate within |
| `agent_id` | string | yes | Stable identifier for the calling agent/session |
| `intent` | string | yes | Short description of the work being claimed |
| `agent_kind` | string | no | `claude`, `cursor`, `codex`, `human`, or `other` (default `other`) |
| `paths` | string[] | no | File/dir paths this work will touch |
| `symbols` | string[] | no | Symbol/node ids this work will touch |
| `capability` | string | no | Capability or feature name this work implements |
| `ttl_ms` | number | no | Freshness TTL in ms (default 5 minutes) |
| `base_commit` | string | no | Base commit for the claim |
| `branch` | string | no | Branch for the claim |
| `claim_id` | string | no | Deprecated compatibility input; the server assigns stream identity |

**Returns:** `claim_id`, compatibility `grant_id`, `verdict: granted`, freshness expiry, literal overlap context when present, derived conceptual coordinates, and conceptual awareness of related active streams. Overlap never changes the verdict.

### `release_work`

Mark one attributed stream complete or handed off. Other overlapping streams remain active.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workspace` | string | yes | Workspace or project id/path |
| `claim_id` | string | yes | Stream id from `claim_work` |
| `agent_id` | string | no | Participant id that owns the stream |

**Returns:** `status` (`released` or an error if `agent_id` is missing), `claim_id`.

### `heartbeat_work`

Refresh a claim's heartbeat so it stays active (does not expire) while work is in progress. Call periodically for long-running tasks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workspace` | string | yes | Workspace or project id/path |
| `claim_id` | string | yes | Claim id to heartbeat |

**Returns:** `status` (`heartbeat` or `not_found`), `claim_id`, `seq`, `heartbeat_at`.

### `get_active_agents`

Live Fabric state for a workspace: participants, active attributed streams, intent, freshness, scope, and overlap context. No participant waits in a queue.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|

| `workspace` | string | yes | Workspace or project id/path |

**Returns:** Presence info plus `streams`, enriched with participant intent and freshness status.

### `check_collision`

Read-only preflight over literal and conceptual scope. It returns related attributed streams, duplicate intent, blast-radius intersections, and semantic divergence without publishing a stream or gating work.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workspace` | string | yes | Workspace or project id/path |
| `paths` | string[] | no | Proposed paths |
| `symbols` | string[] | no | Proposed symbols |
| `capability` | string | no | Proposed capability |

**Returns:** literal and conceptual relationship findings, active attributed streams, evidence, participant intent, and semantic conflict detail. Use it to begin collaboration with relevant participants before or during overlapping work.

### `check_conceptual_conflicts`

Catches semantic incoherence that textual/merge conflicts cannot — two changes that each compile, pass review, and merge cleanly on their own, but are jointly incoherent (the canonical case: one agent retypes `getUser(): User|null -> User` while another agent edits a caller doing `if (!getUser())`). This call is ambient: it captures the caller's own git working-tree diff automatically (the workspace is treated as the caller's repo path; TS/JS files get full before/after signature diffing via the TypeScript compiler API), merges it with any explicitly passed `changes`, persists the merged report so other agents' checks can detect conflicts even if this agent never calls it again, and immediately returns only the conflicts that involve the caller.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workspace` | string | yes | Workspace or project id/path |
| `agent_id` | string | yes | Your stable agent/session id |
| `agent_kind` | string | no | `claude`, `cursor`, `codex`, `human`, or `other` |
| `intent` | string | yes | Short description of the work you are about to do |
| `changes` | array | yes | The symbol changes you are about to make (or are making): each `{ symbol_id, name, file, change_kind: signature\|return_type\|nullability\|param\|rename\|split\|move\|delete\|body\|add, before?, after? }`, with `before`/`after` shape (`signature`, `return_type`, `nullable`, `name`, `split_into`, `body_tags`) where known |

**Returns:** `status: "reported"`, `ambient_changes_captured` count, `other_agents_considered` count, and `conflicts` -- filtered to ones involving this agent: `contract-divergence` (signature/return-type/nullability change vs. a caller assuming the old contract), `duplicate-work` (overlapping intent on the same/similar symbol), `structural-divergence` (rename/split/move/delete vs. a new reference to the old structure), or `behavior-drift` (a guard/early-return added vs. code assuming unconditional execution). Ambient capture is same-machine/single-repo and TS/JS-only for full signature diffing; other languages get an honest unknown-change flag rather than a fabricated diff.

### `get_in_flight_changes`

Which active agents currently have a claim/edit-lock touching a given path, and their stated intent — answers "who is changing this and why" in a shared workspace.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workspace` | string | yes | Workspace or project id/path |
| `path` | string | yes | File or directory path to check |
| `exclude_self` | string | no | agent_id to exclude from results |

**Returns:** Attribution: which agent(s) have an active claim/edit-lock over the path, and their stated intent.

### `subscribe_workspace`

Start (or confirm) live local-peer awareness for a workspace: same-machine claim-log changes are watched via fs events.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workspace` | string | yes | Workspace or project id/path |

**Returns:** `status: "watching"`, `workspace`, and a note that MCP has no server-push transport (stdio) — poll `get_active_agents`/`get_in_flight_changes`/`check_collision` for deltas, or use HTTP `GET /v1/coordination/state?workspace=&since=` for cross-machine polling. See `../COORDINATION-FABRIC.md` for the HTTP `/v1/coordination/*` routes (`claim`, `release`, `heartbeat`, `state`, `stream`, `in-flight`) and the `/v1/telemetry/ingest` route used by telemetry fusion.

### `plan_intent_merge`

Reconcile the end of a shared editing session by INTENT rather than by textual 3-way diff. Git only asks "do the lines overlap?" — two textually-disjoint changes can merge silently even when jointly incoherent, and two changes on the same lines can conflict mechanically even when perfectly compatible in intent (e.g. one agent adding retry, another adding logging, to the same function body). Reuses the same persisted conceptual-conflict state that `check_conceptual_conflicts`/`check_collision` populate, so call one of those at least once per agent first (or pass `states` explicitly).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workspace` | string | yes | Workspace or project id/path |
| `agent_id` | string | yes | Your stable agent/session id (excluded from the "other agents" lookup; included if you also pass it in `states`) |
| `states` | array | no | Explicit agent states to plan a merge over: `{ agent_id, intent, changes: SymbolChange[] }`. Omit to use every other active agent's persisted conceptual-conflict state for `workspace` plus your own ambient working-tree changes |

**Returns:** A `MergePlan` with `auto_mergeable` (compatible intents that compose, with a rationale naming both agents' intents), `needs_resolution` (a genuine conceptual conflict was detected -- not auto-merged even though it would pass a textual merge cleanly), `duplicate_work` (the fleet did the same thing twice; keep one), and a summary count. Plus `agents_considered`.

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

### `get_system_health`

Codebase coherence and risk analysis across architecture, idioms, tests, runtime readiness, and implementation health.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Overall health score/status, coherence status, primary/conflicting paradigms, duplication signals, naming/DI/module-boundary drift counts, risk areas, remediation steps, agent rules, and validation tools.

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

### `get_communities`

Louvain functional modules: clusters of tightly call-connected functions/classes, discovered by community detection over the call graph. Surfaces de-facto modules an agent should treat as a unit.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Communities with member nodes and internal cohesion.

### `get_clones`

Near-duplicate (copy-paste) function/method groups via MinHash + Jaccard over structure-normalized code -- catches renamed clones (Type-2). A refactor and divergence-risk signal.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `threshold` | number | no | Minimum estimated Jaccard similarity to report (0-1, default 0.8) |

**Returns:** Pairs of the two similar functions and an estimated similarity score.

### `get_dead_code`

Functions/methods with zero callers in the call graph, excluding entry points and tests. Surfaces unreachable or unused code (and exported-but-uncalled API surface) for cleanup or review.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Dead-code candidates with location and reason.

### `get_adrs`

List Architecture Decision Records persisted for this project across sessions: the decisions, their status, context, and consequences.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Returns:** Stored ADRs for the project.

### `manage_adr`

Create or update an Architecture Decision Record (persisted across sessions).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `title` | string | yes | Short decision title |
| `decision` | string | yes | The decision made |
| `context` | string | no | Why the decision was needed |
| `consequences` | string | no | Resulting trade-offs |
| `status` | string | no | `proposed`, `accepted`, `deprecated`, or `superseded` |
| `supersedes` | string | no | id of an ADR this replaces |
| `id` | string | no | Existing ADR id to update (omit to create a new ADR) |

**Returns:** The saved/updated ADR.

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

### `install_gauntlet_watcher`

Install a watcher on a repository that automatically runs the incremental-change gauntlet whenever the code changes -- measuring Klauro's advantage on understanding each change (quality/token/speed delta over time). The watcher is persisted and auto-resumes when the gauntlet UI server restarts.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repo_path` | string | yes | Absolute path to the repository to watch (must have a stored analysis) |

**Returns:** The installed watcher record.

### `list_gauntlet_watchers`

List installed gauntlet watchers with their live status, recent changes, and how many incremental gauntlet runs each has produced.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | | | |

**Returns:** Array of gauntlet watcher records with status and run history.

### `stop_gauntlet_watcher`

Stop and disable an installed gauntlet watcher by id.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `id` | string | yes | Gauntlet watcher id from `list_gauntlet_watchers` |

**Returns:** The updated (stopped) watcher record.

### `run_incremental_gauntlet`

Run the incremental-change gauntlet for one repository on demand: projects Klauro vs. every competitor arm on understanding a change and records the quality/token/speed delta. Returns the record and appends it to the repo's incremental history.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repo_name` | string | yes | Analysis name of the repository |
| `files_changed` | number | no | Number of files changed (for change-magnitude) |
| `nodes_added` | number | no | Nodes added |
| `nodes_modified` | number | no | Nodes modified |
| `nodes_deleted` | number | no | Nodes deleted |
| `risk_level` | string | no | Risk level for the change |

**Returns:** `record` (the new incremental gauntlet run) and `history_length` (total records retained, up to 20).
