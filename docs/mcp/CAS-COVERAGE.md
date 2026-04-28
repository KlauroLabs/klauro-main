# Unravl MCP Server - CAS Output Coverage

This document maps public CAS concepts and related v1.8 analysis storage to the MCP tools/resources that expose them. It is a human-maintained coverage guide, not a generated conformance report.

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
| `runtime_static_links` | `get_system_overview` (count), `get_runtime_static_links`, `correlate_runtime_event`, `record_runtime_event` | |
| `analysis_facts` | `get_system_overview` (count), `get_analysis_facts` | |
| `repository_links` | `get_system_overview`, `get_cross_repo_links` | `overview` |
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
| `change_history` storage | `get_changes_since`, `get_changes_between`, `get_changes_for_node`, `get_changes_for_file`, `get_changes_for_entry_point`, `get_change_summary`, `get_hot_spots` | |
| `analysis_snapshots` storage | `get_analysis_at`, `get_analysis_snapshots` | |
| `runtime_observations` storage | `record_runtime_event`, `get_runtime_observations` | |
| Answer packs | `list_answer_packs`, `run_answer_pack`, `get_mcp_demo_flow` | |
| Agent default-use context | `get_agent_bootstrap`, `get_agent_start_context`, `get_agent_tool_plan`, `get_agent_work_packet`, `evaluate_agent_readiness` | `agent-bootstrap`, `agent-start`, `agent-readiness` |
| Ground-truth analysis checks | `evaluate_analysis_truth` | |
| Source-level semantic map | `get_semantic_map` | |
| Framework/library depth | `get_framework_depth_report` | |
| Cross-repository contracts | `get_cross_repo_contracts` | |
| Runtime instrumentation plan | `get_runtime_instrumentation_plan`, `get_runtime_event_contract` | `runtime-event-contract` |
| Agent task proof | `evaluate_agent_task_proof` | |
| `incremental_state` storage | Internal incremental analysis input | |
| `file_cache` storage | Internal incremental analysis cache | |

## Coverage Status

The MCP server exposes the public CAS concepts needed by UI and agent workflows, plus v1.8 change-history and snapshot queries. It also exposes product-level answer packs, cross-repository linking, contract views, runtime observation correlation, instrumentation plans, truth evaluation, semantic maps, and agent default-use readiness on top of CAS. Internal implementation artifacts such as `index`, `incremental_state`, and `file_cache` are intentionally not exposed directly.

When adding a new public CAS field, update this matrix and add a tool/resource entry if humans or agents need to query it.
