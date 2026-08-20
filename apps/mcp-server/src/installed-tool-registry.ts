export const INSTALLED_TOOL_NAMES = [
  'analyze_codebase', 'sync_codebase_remote', 'get_upload_manifest', 'resolve_agent_analysis',
  'get_summary', 'get_product_map', 'get_conceptual_analysis', 'get_data_entities',
  'get_semantic_coverage', 'get_agent_start_context', 'get_agent_tool_plan', 'get_agent_context',
  'search_nodes', 'get_coding_context', 'assess_change_risk', 'find_tests', 'get_user_journeys',
  'get_codebase_idioms', 'get_behavioral_invariants', 'validate_codebase_idioms',
  'validate_behavioral_invariants', 'run_answer_pack', 'get_agent_revision_tracks', 'start_watch', 'stop_watch',
  'get_watch_status', 'list_watches', 'poll_watch_changes',
  'get_module_health',
  'fab_claim_work', 'fab_extend', 'fab_check_collision', 'fab_release_work', 'fab_list_active_work',
  'check_conceptual_conflicts', 'plan_intent_merge', 'plan_parallel_work',
  'list_workspaces', 'run_workspace_analysis', 'get_workspace_analysis',
] as const;

const installedToolNameSet = new Set<string>(INSTALLED_TOOL_NAMES);

export function isInstalledToolName(name: string): boolean {
  return installedToolNameSet.has(name);
}
