# Unravl MCP Server - Prompts Reference

Prompts generate structured context for injection into AI assistant conversations. They compose data from multiple CAS sections into a single coherent narrative.

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

Generates guidance for safely modifying a specific code element. Useful before making changes to understand blast radius and risk.

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `path` | string | yes | Project path |
| `node_id` | string | yes | Node ID of the element to modify |

**Generates sections:**

1. **Header** - Node name, type, file location
2. **Risk Assessment** - Risk level, contributing factors, direct/transitive caller counts, affected entry points, recommendations
3. **Callers** - Up to 20 callers with indentation showing depth, relationship type
4. **Test Coverage** - Test suites covering the node, or warning if uncovered
5. **Stability** - Stability score/class, commit metrics (30d), author count
6. **Connected Components** - Incoming/outgoing edge counts, entry/exit point counts

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
