# Unravl MCP Server - CAS Output Coverage

Every field in the CAS output is surfaced through one or more MCP tools. This document maps CAS fields to the tools/resources that expose them.

## Coverage Matrix

| CAS Field | Tool(s) | Resource(s) |
|-----------|---------|-------------|
| `system` | `get_summary`, `get_system_overview` | `overview` |
| `architecture_summary` | `get_summary`, `get_system_overview` | `overview` |
| `system_purpose` | `get_summary`, `get_system_overview` | `overview` |
| `enhanced_system_purpose` | `get_summary`, `get_system_overview` | `overview` |
| `system_capabilities` | `get_system_overview` | `overview` |
| `progressive_levels` | `get_system_overview`, `get_level` | `overview` |
| `configuration` | `get_system_overview` | `overview` |
| `runtime` | `get_system_overview` | `overview` |
| `repository_links` | `get_system_overview` | `overview` |
| `disclosure` | `get_system_overview` | `overview` |
| `validation` | `get_system_overview` | `overview` |
| `analyzer_contributions` | `get_summary`, `get_system_overview` | `overview` |
| `analysis_errors` | `get_summary`, `get_system_overview` | `health` |
| `nodes` | `search_nodes`, `get_node`, `get_file_nodes` | |
| `edges` | `get_node`, `get_callers`, `get_callees`, `get_file_nodes` | |
| `entry_points` | `get_entry_points`, `get_node` | `endpoints` |
| `exit_points` | `get_exit_points`, `get_node` | |
| `route_table` | `get_route_table` | `endpoints` |
| `external_services` | `get_external_services` | |
| `method_calls` | `get_method_calls`, `get_callers`, `get_callees` | |
| `call_chains` | `get_call_chain` | |
| `decorators` | `get_node` | |
| `intents` | `get_intent`, `get_node` | |
| `data_entities` | `get_data_entities` | `schema` |
| `data_summary` | `get_data_entities` | `schema` |
| `database_schema` | `get_database_schema` | `schema` |
| `security_boundaries` | `get_security_overview` | `security` |
| `security_summary` | `get_security_overview` | `security` |
| `security_contexts` | `get_security_overview` | `security` |
| `change_risks` | `assess_change_risk`, `get_node` | `risks` |
| `change_risk_summary` | `assess_change_risk` | `risks` |
| `temporal_stability` | `get_stability`, `get_node` | `risks` |
| `stability_summary` | `get_stability` | `risks` |
| `flow_graph` | `get_summary` (condensed), `get_flow_graph` (full) | |
| `flow_summary` | `get_flow_coverage` | `flows` |
| `flow_coverage` | `get_flow_coverage` | `flows` |
| `test_gaps` | `get_test_summary`, `get_flow_coverage` | `flows`, `risks` |
| `test_suites` | `find_tests` | |
| `test_summary` | `get_test_summary` | |
| `test_coverage` | `find_tests`, `get_test_summary` | |
| `mocks` | `find_tests`, `get_test_summary` | |
| `fixtures` | `find_tests`, `get_test_summary` | |
| `workflows` | `get_workflows` | `flows` |
| `workflow_graph` | `get_workflows` | `flows` |
| `domain_concepts` | `get_domain_concepts` | |
| `patterns` | `get_patterns` | |
| `categories` | `get_patterns` | |
| `behaviors` | `get_patterns` | |
| `perspectives` | `get_perspectives` | |
| `implementation_health` | `get_implementation_health` | `health` |
| `documentation_summary` | `get_documentation_coverage` | `health` |
| `todos_summary` | `get_todos` | `health` |
| `dependencies` | `get_dependencies` | |
| `libraries` | `get_libraries` | |
| `tags` | `search_nodes` | |
| `index` | Internal (search optimization) | |

## Coverage: 100%

Every CAS output field is accessible through at least one MCP tool or resource. The `index` field is used internally for search optimization and is not directly exposed.
