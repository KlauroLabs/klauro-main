export const INSTALLED_CLIENT_INSTRUCTIONS = `Klauro serves a hosted, precomputed analysis of this repository: call graph, entry points, data entities, flows, conventions, and tests. Default to it over grep/Read for code work: a query returns real call sites, blast radius, and the tests to run. Every result is a bounded hosted slice stamped to a commit; nothing is analyzed on this machine.

Tool schemas may be deferred. If these tools are not callable yet, load them first (in Claude Code: ToolSearch with "select:<tool name>" or the query "klauro"). Do not conclude Klauro is unavailable until a schema load has been tried.

Orient (once per repo): resolve_agent_analysis(path) confirms a ready analysis is bound to this path. get_agent_start_context(path) gives task-scoped orientation, get_summary the domain, capabilities, and entry points, get_product_map the deployables and runtime topology, get_data_entities the domain's data shapes, and get_agent_tool_plan the query sequence for your task.

Find instead of grep: search_nodes ranks nodes by name and meaning with file:line and risk flags. get_semantic_map maps a file's symbols and their calls, get_user_journeys traces source-to-terminal journeys, and find_tests returns the suites covering a node or file; pull it before writing tests so you extend existing suites.

Understand before editing (highest value): get_coding_context(target) returns the node with conventions, boundaries, callers, callees, and the tests to run in one call. get_conceptual_analysis breaks a capability into flows and ordered steps; use it to see what a request actually does before you drop to one function. get_codebase_idioms and get_behavioral_invariants state the repo's conventions and the auth, tenant, data, and test rules that must hold.

Change, then verify: assess_change_risk before a risky edit; validate_codebase_idioms and validate_behavioral_invariants against your working diff afterward. sync_codebase_remote uploads in-flight working-tree changes so queries reflect your edits; analyze_codebase uploads the committed snapshot. start_watch keeps in-flight changes synced.

Coordinate when several agents share the repo: plan_parallel_work batches tasks, fab_claim_work announces your scope, fab_check_collision and check_conceptual_conflicts show overlap, plan_intent_merge reconciles finished work, and fab_release_work clears your claim. Claims are advisory and never block.

Trust, then verify: if a query returns nothing for a file you can see on disk, it is likely uncommitted or on an unmerged branch; run sync_codebase_remote or read that file. On any tool error, fall back to reading the source.

Status meanings: no_analysis, or a 404 for the project, means no hosted analysis is bound or visible to the active account. Run klauro accounts to see signed-in accounts and klauro accounts --use <account> to switch, or klauro init --force to bind a new project, then analyze_codebase. Never run klauro login: it replaces the active session. A populating status means the analysis is still building; retry shortly.

If resolve_agent_analysis returns a client_build_warning, relay it to the human: restarting the MCP client is the only way to load a newer build.`;
