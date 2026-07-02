# Klauro MCP Server - CAS Output Coverage

This document maps public CAS concepts and related analysis storage (current `CAS_VERSION` 1.11.0 — see [`../cas/VERSIONING.md`](../cas/VERSIONING.md)) to the MCP tools/resources that expose them. It is a human-maintained coverage guide, not a generated conformance report.

## Coverage Matrix

| CAS Field | Tool(s) | Resource(s) |
|-----------|---------|-------------|
| `system` | `get_summary`, `get_system_overview` | `overview` |
| `architecture_summary` | `get_summary`, `get_system_overview` | `overview` |
| `system_purpose` | `get_summary`, `get_system_overview` | `overview` |
| `enhanced_system_purpose` | `get_summary`, `get_system_overview` | `overview` |
| `system_capabilities` | `get_system_overview` | `overview` |
| `analysis_phases` | `get_analysis_phases`, `run_analysis_layer`, `analyze_codebase` | `overview` |
| `progressive_levels` | `get_system_overview`, `get_level` | `overview` |
| `configuration` | `get_system_overview` | `overview` |
| `runtime` | `get_system_overview` | `overview` |
| `runtime_static_links` | `get_system_overview` (count), `get_runtime_static_links`, `simulate_runtime_telemetry`, `correlate_runtime_event`, `record_runtime_event`, `validate_cas_contract` | `cas-contract` |
| `analysis_facts` | `get_system_overview` (count), `get_analysis_facts` | |
| `codebase_idioms` | `get_codebase_idioms`, `get_idiom_aware_agent_context`, `get_agent_context`, `validate_codebase_idioms`, `evaluate_agent_readiness` | `agent-context` |
| `idiom_summary` | `get_system_overview`, `get_codebase_idioms`, `evaluate_agent_readiness` | `overview`, `agent-readiness` |
| `idiom_examples` | `get_idiom_examples`, `get_codebase_idioms`, `get_agent_context` | `agent-context` |
| `idiom_violations` | `get_codebase_idioms`, `validate_codebase_idioms` | |
| `system_health` | `get_system_overview`, `get_system_health`, `get_agent_context`, `get_operational_priorities` | `health`, `agent-context`, `risks` |
| `repository_links` | `get_system_overview`, `get_cross_repo_links`, `save_workspace_graph`, `get_workspace_graph`, `verify_workspace_link` | `overview`, `workspace/{id}/graph` |
| `disclosure` | `get_system_overview` | `overview` |
| `validation` | `get_system_overview`, `validate_cas_contract` | `overview`, `cas-contract` |
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
| `behavioral_invariants` | `get_behavioral_invariants`, `validate_behavioral_invariants`, `get_agent_context`, `evaluate_agent_readiness` | `agent-context` |
| `behavioral_invariant_summary` | `get_behavioral_invariants`, `validate_cas_contract`, `evaluate_agent_readiness` | `cas-contract`, `agent-readiness` |
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
| Source test discovery evidence | `get_test_discovery_evidence`, `evaluate_agent_readiness`, `get_agent_doctor` | `test-discovery`, `agent-readiness`, `agent-doctor` |
| `workflows` | `get_workflows` | `flows` |
| `workflow_graph` | `get_workflows` | `flows` |
| `domain_concepts` | `get_domain_concepts` | |
| `patterns` | `get_patterns` | |
| `categories` | `get_patterns` | |
| `behaviors` | `get_patterns` | |
| `perspectives` | `get_perspectives` | |
| `implementation_health` | `get_implementation_health`, `get_system_health` | `health` |
| `documentation_summary` | `get_documentation_coverage` | `health` |
| `todos_summary` | `get_todos` | `health` |
| `dependencies` | `get_dependencies`, `get_integration_depth_report` | `integration-depth` |
| `libraries` | `get_libraries`, `get_integration_depth_report` | `integration-depth` |
| `tags` | `search_nodes` | |
| `index` | Internal (search optimization) | |
| Remote analyzer sync and customer upload policy | `initialize_klauro_project`, `get_klauro_project_config`, `get_upload_manifest`, `analyze_codebase_remote`, `sync_codebase_remote`, `get_github_import_plan` | |
| `change_history` storage | `get_changes_since`, `get_changes_between`, `get_changes_for_node`, `get_changes_for_file`, `get_changes_for_entry_point`, `get_change_summary`, `get_hot_spots` | |
| `analysis_snapshots` storage | `get_analysis_at`, `get_analysis_snapshots` | |
| `runtime_observations` storage | `simulate_runtime_telemetry`, `record_runtime_event`, `get_runtime_observations`, `get_runtime_trace`, `get_operational_priorities`, `validate_cas_contract` | `cas-contract`, `risks` |
| Answer packs | `list_answer_packs`, `run_answer_pack`, `get_mcp_demo_flow` | |
| Agent agent-context-ready context | `resolve_agent_analysis`, `get_agent_project_map`, `get_agent_bootstrap`, `get_agent_start_context`, `get_agent_tool_plan`, `get_agent_context`, `get_capability_memory`, `get_idiom_aware_agent_context`, `validate_behavioral_invariants`, `validate_codebase_idioms`, `evaluate_agent_readiness`, `get_agent_default_config`, `install_agent_default_config` | `agent-bootstrap`, `agent-start`, `agent-readiness`, `agent-defaults` |
| Ground-truth analysis checks | `evaluate_analysis_truth` | |
| Source-level semantic map | `get_semantic_map` | |
| Framework/library depth | `get_framework_depth_report`, `get_integration_depth_report` | `integration-depth` |
| Cross-repository contracts | `get_cross_repo_contracts`, `save_workspace_graph`, `get_workspace_graph`, `verify_workspace_link` | `workspaces`, `workspace/{id}/graph` |
| Runtime instrumentation plan | `get_runtime_instrumentation_plan`, `get_runtime_event_contract` | `runtime-event-contract` |
| Runtime SDK package | `get_runtime_sdk_package`, `get_agent_doctor` | `runtime-sdk`, `agent-doctor` |
| Agent task proof | `evaluate_agent_task_proof` | |
| Agentic benchmark reports | `run_agentic_benchmark`, `run_agent_quality_benchmark`, `run_agent_idiom_benchmark`, `run_incremental_value_benchmark`, `run_machine_agent_proof`, `get_agentic_benchmark_report`, `get_agent_performance_proof` | `agentic-benchmarks`, `agent-performance-proof`, `agentic-benchmark/{id}` |
| Live agent A/B trial artifacts | `run_agent_quality_benchmark`, `run_agent_idiom_benchmark`, `run_machine_agent_proof` with live command templates | `agentic-benchmarks`, `agentic-benchmark/{id}` |
| Incremental edit performance proof | `run_incremental_value_benchmark`, `get_analysis_freshness`, `get_change_summary` | `agentic-benchmarks`, `agentic-benchmark/{id}` |
| Storage health | `get_storage_health` | |
| Analysis freshness | `get_analysis_freshness`, `get_agent_doctor` | `freshness`, `agent-doctor` |
| CAS golden-shape validation | `validate_cas_contract`, `save_cas_golden_snapshot`, `compare_cas_golden_snapshot`, `get_agent_doctor` | `cas-contract`, `agent-doctor` |
| `incremental_state` storage | Internal incremental analysis input | |
| `file_cache` storage | Internal incremental analysis cache | |
| `workspace_graphs` storage | `save_workspace_graph`, `get_workspace_graph`, `list_workspace_graphs`, `verify_workspace_link`, `get_storage_health` | `workspaces`, `workspace/{id}/graph` |
| `agentic_benchmarks` storage | `run_agentic_benchmark`, `get_agentic_benchmark_report`, `get_storage_health` | `agentic-benchmarks`, `agentic-benchmark/{id}` |

## Coverage Status

The MCP server exposes the public CAS concepts needed by UI and agent workflows, plus v1.8 change-history/snapshot queries, v1.9 codebase-idiom queries/validation, v1.10 system-health/coherence and graph-anchored semantic retrieval (`embedding_index`), and the v1.10-line behavior pillars attested current as of v1.11.0 (`user_journeys`, `data_lineage`, `paradigm_conformance`, `product_map` — see `get_user_journeys`, `get_data_lineage`, `get_paradigm_conformance`, `get_product_map`). It also exposes product-level answer packs, persisted workspace graphs, cross-repository linking, contract views, behavioral invariants, invariant-aware and idiom-aware diff validation, runtime observation correlation and trace replay, operational priority ranking, instrumentation plans, runtime SDK package generation, truth evaluation, semantic maps, integration depth reports, source test discovery evidence, analysis freshness, CAS contract validation, saved golden-shape comparisons, storage health, agent-context-ready readiness, monorepo/subproject analysis resolution, installable agent defaults, customer upload manifests, GitHub import planning, remote analyzer full/incremental sync, with-Klauro vs without-Klauro benchmark reports, machine-wide proof, live copied-repo agent trial artifacts, and (net-new, see [`../COORDINATION-FABRIC.md`](../COORDINATION-FABRIC.md)) multi-agent coordination (claims, presence, collision detection, in-flight change awareness) on top of CAS. Internal implementation artifacts such as `index`, `incremental_state`, and `file_cache` are intentionally not exposed directly beyond aggregate storage health and freshness checks.

When adding a new public CAS field, update this matrix and add a tool/resource entry if humans or agents need to query it.
