# Unravl MCP Server - CLAUDE.md Prompt

Add the following block to the `CLAUDE.md` of any project that has the Unravl MCP server configured. This instructs AI assistants to use Unravl as their primary source of codebase understanding.

---

```markdown
## Codebase Intelligence (Unravl)

Use the Unravl MCP server as the primary source of truth for understanding this codebase. Do not rely on reading files to understand architecture, relationships, or system structure -- query the analysis instead.

When you need codebase context, call `get_summary` with this project's root path. If the analysis does not exist, call `analyze_codebase` to generate it first, then proceed.

### Orientation
- `get_summary` -- system purpose, tech stack, architecture layers, scale, top capabilities
- `get_level` -- progressive disclosure; start at level 1 and drill deeper to understand the system layer by layer
- `get_system_overview` -- full system metadata when you need more than the summary

### Before modifying code
- `search_nodes` to locate the code element by name
- `get_node` for full context: connections, decorators, intent, stability
- `assess_change_risk` to understand blast radius and downstream impact
- `get_callers` to see what depends on it
- `find_tests` to check existing test coverage

### Navigating the system
- `get_level` to explore one architectural layer at a time, following cross-level edges to drill deeper
- `get_entry_points` and `get_route_table` for API surface
- `get_call_chain` to trace full execution paths from entry to exit
- `get_callers` / `get_callees` to traverse the call graph in either direction
- `get_file_nodes` to understand everything in a specific file

### Data and security
- `get_database_schema` and `get_data_entities` for data model and lifecycle
- `get_security_overview` for trust boundaries and enforcement gaps

### Health and quality
- `get_test_summary` and `get_flow_coverage` for test coverage and gaps
- `get_implementation_health` for completeness and risk areas
- `get_stability` for churn hotspots

Do not guess at how the system is structured. Query the analysis.
```
