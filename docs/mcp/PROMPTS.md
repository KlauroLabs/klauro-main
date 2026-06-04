# Klauro MCP Server - Prompts Reference

Prompts generate structured context for injection into AI assistant conversations. They compose data from multiple CAS sections into a single coherent narrative.

---

## `agent_coding_session`

Default prompt for Codex, Claude, Cursor, and other agents. It resolves the best stored analysis for the requested path, then loads CAS readiness, start context, task-specific MCP tool plan, and the work packet before source-file exploration.

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `task_type` | string | no | One of `orient`, `modify`, `debug`, `review`, `trace`, `cross-repo`, or `runtime` |
| `target` | string | no | Task target, such as a feature, node, file, route, error, or subsystem |
| `instructions` | string | no | Exact user instructions to preserve in the work packet |
| `success_criteria` | string[] | no | Success criteria for the task |

**Generates sections:**

1. **Analysis Resolution** - Requested path, selected path, and recommendation when a subproject analysis is chosen
2. **Header** - System name, default-use status, readiness score, and adoption gaps
3. **Operating Rule** - When to use MCP and when to read source files
4. **System** - Type, description, languages, frameworks, and top capabilities
5. **Scale** - Node, edge, entry point, and analysis error counts
6. **Answer Pack Gaps** - Any missing explanation surfaces
7. **MCP Plan** - Ordered tool calls with arguments and purpose
8. **Selected Target** - Resolved CAS node for the task when available
9. **File Read Plan** - First source files to inspect with reasons
10. **Invariant Impact** - Behavior-level invariants likely affected by the task
11. **When To Read Files** - Concrete conditions for targeted source inspection

**Proposal preview rule:** When the agent is still in planning mode and has a concrete multi-file diff, refactor, removal, or proposed file bundle, call `preview_codebase_iteration` or `preview_greenfield_codebase` before finalizing the plan. Include the Klauro advisory verdict, private preview URL, changed contracts, required checks, and known uncertainty in the plan text. CAS remains a codebase analysis output; proposal metadata is stored separately.

---

## `architectural_context`

Generates comprehensive architectural context for a codebase. Designed to be injected at the start of a coding session to give an AI assistant full awareness of the system.

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Generates sections:**

1. **Header** - System name, type, domain, description, core concepts
2. **Tech Stack** - Languages, frameworks, databases
3. **Architecture Layers** - Presentation, business, data, infrastructure breakdown
4. **Scale** - Node/edge counts, entry point counts by type
5. **API Routes** - Up to 30 routes with method, path, controller, handler, auth status
6. **Database** - ORM name, entity listing
7. **Capabilities** - Total count, detected patterns, primary entry type, data flow type, top 10 capabilities by score
8. **Security** - Boundary count, enforced/assumed/missing breakdown
9. **Patterns** - Detected design patterns with type, confidence, instance count

---

## `safe_modification_guide`

Generates guidance for safely modifying a specific code element. Useful before making changes to understand blast radius, risk, tests, behavioral invariants, repo-local idioms, and required post-edit validation.

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | yes | Node ID of the element to modify |

**Generates sections:**

1. **Header** - Node name, type, file location
2. **Risk Assessment** - Risk level, contributing factors, direct/transitive caller counts, affected entry points, recommendations
3. **Callers** - Up to 20 callers with indentation showing depth, relationship type
4. **Test Coverage** - Test suites covering the node, or warning if uncovered
5. **Behavioral Invariants** - Relevant tenant/auth/schema/test invariants and the `validate_behavioral_invariants` call to run after edits
6. **Codebase Idioms** - Relevant local naming, placement, testing, migration, error/logging, boundary, and configuration practices plus the `validate_codebase_idioms` call to run after edits
7. **Agent Workflow** - Prefer `open_agent_workbench` before broad source reads, `preflight_agent_change` before multi-file plans or edits, and `validate_agent_change` before finalizing
8. **Stability** - Stability score/class, commit metrics (30d), author count
9. **Connected Components** - Incoming/outgoing edge counts, entry/exit point counts

---

## `test_coverage_analysis`

Generates a test coverage report highlighting gaps and untested critical paths.

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `path` | string | yes | Project path |

**Generates sections:**

1. **Overview** - Total test count, breakdown by type (unit/integration/e2e/acceptance), overall coverage percentage, mock and fixture counts
2. **Test Gaps** - Count by severity, critical and high severity gaps listed with gap type and recommendation (up to 20)
3. **Flow Coverage** - Fully/partially/not covered flow counts
4. **Implementation Health** - Health score, complete/partial/stub counts, risk areas with level and recommendation
