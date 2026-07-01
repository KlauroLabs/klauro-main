# Klauro MCP Server - Resources Reference

Resources provide stable, pre-composed views of analysis data. They are read-only and accessed by URI. Templated resources use `{project_name}` which is the slugified project name (lowercase, alphanumeric, hyphens).

---

## `klauro://analyses`

List of all analyzed codebases with metadata.

**Returns:** Array of entries with name, path, file, analyzed_at, system_type, frameworks, node_count, edge_count.

---

## `klauro://workspaces`

List of persisted multi-repository workspace graphs.

**Returns:** Array of workspace graph entries with id, name, timestamps, repository count, link count, and storage file.

---

## `klauro://workspace/{workspace_id_or_name}/graph`

Persisted cross-repository workspace graph.

**Includes:** repositories, repository contracts, detected links, confidence, evidence counts, conflicts, and review decisions.

---

## `klauro://agentic-benchmarks`

List of persisted with-Klauro vs without-Klauro benchmark reports.

**Returns:** Array of report entries with id, timestamps, status, score, target count, and storage file.

---

## `klauro://agent-performance-proof`

Recent proof that Klauro improves agent token use, speed, quality, and incremental edit-loop performance.

**Returns:** Current 7-day proof summary with live A/B rollups, idiom-quality proof, latest report summaries by benchmark type, proof claims, compact metrics, and Markdown.

---

## `klauro://agentic-benchmark/{report_id}`

One persisted agentic benchmark, live-quality, idiom-quality, or incremental value report.

**Includes:** JSON report and report-type-specific Markdown rendering. Deterministic, live-quality, idiom-quality, and incremental reports each use their own formatter.

---

## `klauro://{project_name}/overview`

System overview combining architecture summary, tech stack, system purpose, capabilities, and progressive disclosure levels.

**Includes:** `system`, `architecture_summary`, `system_purpose`, `enhanced_system_purpose`, `system_capabilities`, `progressive_levels`, `analyzer_contributions`, `analysis_errors`, `configuration`, `runtime`, `repository_links`, `idiom_summary`, `disclosure`, `validation`.

---

## `klauro://{project_name}/agent-bootstrap`

Default agent bootstrap payload for coding agents.

**Includes:** agent-context-ready rule, readiness report, start context, task plan, agent context, idiom context, file read plan, agent workbench guidance, and ready-to-use prompt text.

---

## `klauro://{project_name}/agent-start`

Default CAS-backed start context for coding agents before broad file reads.

**Includes:** agent-context-ready rule, readiness summary, system summary, scale metrics, top entry/exit points, connected nodes, runtime links, idiom summary, answer-pack status, recommended first MCP tools, and file-read guidance.

---

## `klauro://{project_name}/agent-readiness`

Agent-use readiness score and gaps for agent adoption.

**Includes:** pass/warn/fail status, score, `agent_context_ready`, summary metrics, readiness gates, adoption gaps, and required agent behavior.

---

## `klauro://{project_name}/agent-doctor`

One-shot agent-context-ready health report for coding agents.

**Includes:** pass/warn/fail status, `agent_context_ready`, readiness report, analysis freshness, test discovery evidence, runtime event contract proof, runtime SDK package proof, golden snapshot comparison, and first recommended MCP tools.

---

## `klauro://{project_name}/agent-defaults`

Install-ready agent-context-ready instructions for coding agents.

**Includes:** required agent rule, MCP server command, first calls, prompt text, doctor output, and bootstrap output.

---

## `klauro://{project_name}/freshness`

Stored analysis freshness against the current source tree.

**Includes:** fresh/stale/no-analysis status, analyzed-at timestamp, latest source modification time, source file counts, tracked file counts, modified sample files, and recommendation.

---

## `klauro://{project_name}/test-discovery`

Source test evidence compared to the CAS test surface.

**Includes:** status, CAS suite count, discovered source test file count, potential uncovered test files, test configuration files, sample source test files, and summary.

---

## `klauro://{project_name}/runtime-event-contract`

SDK-facing runtime event schema for CAS correlation.

**Includes:** transport details, event fields, correlation order, per-runtime-link event payloads, SDK method contract, totals, and gaps.

---

## `klauro://{project_name}/runtime-sdk`

Deterministic TypeScript runtime SDK package generated from the CAS runtime contract.

**Includes:** package manifest, transport target, generated files with hashes, quick-start commands, and proof metadata tying SDK output to runtime links.

---

## `klauro://{project_name}/integration-depth`

Library and platform integration depth report.

**Includes:** jobs, brokers, auth, payments, AI SDKs, infrastructure, observability, cache, and persistence coverage, with evidence, found surfaces, missing extracted surfaces, unobserved optional surfaces, and recommended analyzers.

---

## `klauro://{project_name}/cas-contract`

Executable CAS completeness report.

**Includes:** pass/warn/fail status, graph completeness gates, entry/exit reference checks, runtime-link checks, evidence coverage, runtime-observation correlation, and a golden-shape snapshot summary.

---

## `klauro://{project_name}/endpoints`

All entry points and the HTTP route table.

**Includes:** `entry_points` (all types: http, websocket, cli, event, schedule, etc.) and `route_table` (method, path, controller, handler, auth, guards, middleware).

---

## `klauro://{project_name}/schema`

Database schema and data entity lifecycle.

**Includes:** `database_schema` (entities, fields, relationships from ORM analysis) and `data_entities` (CRUD lifecycle, transformations, invariants, sensitive data, validation gaps).

---

## `klauro://{project_name}/security`

Security posture of the system.

**Includes:** `security_boundaries` (trust transitions, enforcement points, bypass risks), `security_summary` (enforced vs assumed vs missing), `security_contexts` (per-node trust levels, protection gaps).

---

## `klauro://{project_name}/health`

Code health metrics.

**Includes:** `implementation_health` (completeness score, risk areas), `documentation_coverage` (coverage by type, quality metrics), `todos` (counts, tech debt, blocking items), `analysis_errors`.

---

## `klauro://{project_name}/flows`

Workflow and flow analysis.

**Includes:** `flow_summary`, `workflows` (with workflow_graph, dependency links, critical shared nodes), `flow_coverage` (per-flow test coverage, test gaps).

---

## `klauro://{project_name}/risks`

Risk and stability analysis.

**Includes:** `change_risk_summary`, `stability_summary` (hotspots, legacy areas, by-class breakdown), `test_gaps` (untested flows, severity, recommendations).

---

## Resource vs Tool

Resources are best for loading a complete view of a domain in a single read. Tools are best for dynamic queries with parameters (searching, filtering, traversing specific nodes).

| Need | Use |
|------|-----|
| Start an agent session | Resource: `klauro://{name}/agent-bootstrap` or Prompt: `agent_coding_session` |
| Check whether agents should default to MCP | Resource: `klauro://{name}/agent-readiness` or Tool: `evaluate_agent_readiness` |
| Run the full agent-context-ready doctor | Resource: `klauro://{name}/agent-doctor` or Tool: `get_agent_doctor` |
| Install agent-context-ready agent instructions | Resource: `klauro://{name}/agent-defaults` or Tool: `install_agent_default_config` |
| Check whether stored analysis is stale | Resource: `klauro://{name}/freshness` or Tool: `get_analysis_freshness` |
| Verify whether tests were found or missed | Resource: `klauro://{name}/test-discovery` or Tool: `get_test_discovery_evidence` |
| Get SDK runtime event payloads | Resource: `klauro://{name}/runtime-event-contract` or Tool: `get_runtime_event_contract` |
| Generate a runtime SDK package | Resource: `klauro://{name}/runtime-sdk` or Tool: `get_runtime_sdk_package` |
| Check integration analyzer depth | Resource: `klauro://{name}/integration-depth` or Tool: `get_integration_depth_report` |
| Load a multi-repo graph | Resource: `klauro://workspace/{id}/graph` or Tool: `get_workspace_graph` |
| Load benchmark proof | Resource: `klauro://agent-performance-proof` or Tool: `get_agent_performance_proof` |
| Validate CAS completeness | Resource: `klauro://{name}/cas-contract` or Tool: `validate_cas_contract` |
| Load all endpoints at once | Resource: `klauro://{name}/endpoints` |
| Filter entry points by type | Tool: `get_entry_points` with `type` param |
| Get full security posture | Resource: `klauro://{name}/security` |
| Assess risk for one node | Tool: `assess_change_risk` with `node_id` |
| List all analyses | Resource: `klauro://analyses` |
| Analyze a new codebase | Tool: `analyze_codebase` |
