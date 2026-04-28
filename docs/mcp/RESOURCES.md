# Unravl MCP Server - Resources Reference

Resources provide stable, pre-composed views of analysis data. They are read-only and accessed by URI. Templated resources use `{project_name}` which is the slugified project name (lowercase, alphanumeric, hyphens).

---

## `unravl://analyses`

List of all analyzed codebases with metadata.

**Returns:** Array of entries with name, path, file, analyzed_at, system_type, frameworks, node_count, edge_count.

---

## `unravl://{project_name}/overview`

System overview combining architecture summary, tech stack, system purpose, capabilities, and progressive disclosure levels.

**Includes:** `system`, `architecture_summary`, `system_purpose`, `enhanced_system_purpose`, `system_capabilities`, `progressive_levels`, `analyzer_contributions`, `analysis_errors`, `configuration`, `runtime`, `repository_links`, `disclosure`, `validation`.

---

## `unravl://{project_name}/agent-start`

Default CAS-backed start context for coding agents before broad file reads.

**Includes:** agent default-use rule, readiness summary, system summary, scale metrics, top entry/exit points, connected nodes, runtime links, answer-pack status, recommended first MCP tools, and file-read guidance.

---

## `unravl://{project_name}/agent-readiness`

Default-use readiness score and gaps for agent adoption.

**Includes:** pass/warn/fail status, score, `default_use`, summary metrics, readiness gates, adoption gaps, and required agent behavior.

---

## `unravl://{project_name}/endpoints`

All entry points and the HTTP route table.

**Includes:** `entry_points` (all types: http, websocket, cli, event, schedule, etc.) and `route_table` (method, path, controller, handler, auth, guards, middleware).

---

## `unravl://{project_name}/schema`

Database schema and data entity lifecycle.

**Includes:** `database_schema` (entities, fields, relationships from ORM analysis) and `data_entities` (CRUD lifecycle, transformations, invariants, sensitive data, validation gaps).

---

## `unravl://{project_name}/security`

Security posture of the system.

**Includes:** `security_boundaries` (trust transitions, enforcement points, bypass risks), `security_summary` (enforced vs assumed vs missing), `security_contexts` (per-node trust levels, protection gaps).

---

## `unravl://{project_name}/health`

Code health metrics.

**Includes:** `implementation_health` (completeness score, risk areas), `documentation_coverage` (coverage by type, quality metrics), `todos` (counts, tech debt, blocking items), `analysis_errors`.

---

## `unravl://{project_name}/flows`

Workflow and flow analysis.

**Includes:** `flow_summary`, `workflows` (with workflow_graph, dependency links, critical shared nodes), `flow_coverage` (per-flow test coverage, test gaps).

---

## `unravl://{project_name}/risks`

Risk and stability analysis.

**Includes:** `change_risk_summary`, `stability_summary` (hotspots, legacy areas, by-class breakdown), `test_gaps` (untested flows, severity, recommendations).

---

## Resource vs Tool

Resources are best for loading a complete view of a domain in a single read. Tools are best for dynamic queries with parameters (searching, filtering, traversing specific nodes).

| Need | Use |
|------|-----|
| Start an agent session | Resource: `unravl://{name}/agent-start` or Prompt: `agent_coding_session` |
| Check whether agents should default to MCP | Resource: `unravl://{name}/agent-readiness` or Tool: `evaluate_agent_readiness` |
| Load all endpoints at once | Resource: `unravl://{name}/endpoints` |
| Filter entry points by type | Tool: `get_entry_points` with `type` param |
| Get full security posture | Resource: `unravl://{name}/security` |
| Assess risk for one node | Tool: `assess_change_risk` with `node_id` |
| List all analyses | Resource: `unravl://analyses` |
| Analyze a new codebase | Tool: `analyze_codebase` |
