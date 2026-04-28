import type { CASOutput, CASNode } from '../../backend/src/types/cas.types';
import {
  assessChangeRisk,
  buildSummary,
  findTests,
  getCallees,
  getCallChain,
  getCallers,
  getCodingContext,
  getEntryPoints,
  getErrorContracts,
  getExitPoints,
  getFlowCoverage,
  getRuntimeStaticLinks,
  getSecurityOverview,
  searchNodes,
} from './query';
import { runAnswerPack } from './product';

export type AgentTaskType = 'orient' | 'modify' | 'debug' | 'review' | 'trace' | 'cross-repo' | 'runtime';
type GateStatus = 'pass' | 'warn' | 'fail';

export interface AgentTask {
  task_type?: AgentTaskType;
  target?: string;
  related_paths?: string[];
  runtime_event?: Record<string, unknown>;
}

interface AgentToolStep {
  order: number;
  tool: string;
  args: Record<string, unknown>;
  purpose: string;
  required: boolean;
}

interface AgentReadinessGate {
  id: string;
  status: GateStatus;
  score: number;
  detail: string;
}

export interface AgentReadinessReport {
  path: string;
  name: string;
  generated_at: string;
  status: GateStatus;
  score: number;
  default_use: boolean;
  summary: {
    nodes: number;
    edges: number;
    entry_points: number;
    exit_points: number;
    call_chains: number;
    method_calls: number;
    runtime_static_links: number;
    analysis_facts: number;
    tests: number;
    analysis_errors: number;
  };
  gates: AgentReadinessGate[];
  adoption_gaps: string[];
  required_agent_behavior: string[];
}

interface FileReadPlanItem {
  file: string;
  reason: string;
  node_ids: string[];
  line?: number;
}

export function getAgentStartContext(cas: CASOutput, path: string, task: AgentTask = {}) {
  const summary = buildSummary(cas);
  const answerPack = runAnswerPack(cas, path);
  const readiness = evaluateAgentReadiness(cas, path);
  const topNodes = mostConnectedNodes(cas).slice(0, 8).map(node => ({
    id: node.id,
    name: node.name,
    type: node.type,
    file: node.source?.file,
    line: node.source?.line,
  }));
  const entryPoints = getEntryPoints(cas, { limit: 8 });
  const exitPoints = getExitPoints(cas, { limit: 8 });
  const runtimeLinks = getRuntimeStaticLinks(cas, { limit: 8 });

  return {
    path,
    generated_at: new Date().toISOString(),
    default_rule: 'Use this CAS-backed MCP context before broad file reads. Read source files after MCP narrows the target or when CAS reports a gap.',
    task: normalizeTask(task),
    readiness: {
      status: readiness.status,
      score: readiness.score,
      default_use: readiness.default_use,
      gaps: readiness.adoption_gaps,
    },
    system: {
      name: summary.name,
      type: summary.type,
      description: summary.description,
      primary_domain: summary.primary_domain,
      architecture_type: summary.architecture_type,
      languages: summary.languages,
      frameworks: summary.frameworks,
      top_capabilities: summary.top_capabilities,
    },
    scale: {
      nodes: summary.nodes,
      edges: summary.edges,
      entry_points: summary.entry_points,
      entry_points_by_type: summary.entry_points_by_type,
      database_entities: summary.database_entities,
      capabilities: summary.capabilities,
      analysis_errors: summary.errors,
    },
    starting_points: {
      entry_points: entryPoints.entry_points.map(entry => ({
        id: entry.id,
        name: entry.name,
        type: entry.type,
        trigger: entry.trigger,
        handler: entry.handler,
      })),
      exit_points: exitPoints.exit_points.map(exitPoint => ({
        id: exitPoint.id,
        name: exitPoint.name,
        type: exitPoint.type,
        source_node: exitPoint.source_node,
        target: exitPoint.target,
      })),
      connected_nodes: topNodes,
      runtime_static_links: runtimeLinks.links,
    },
    answer_pack: {
      status: answerPack.gaps.length === 0 ? 'ready' : 'needs-review',
      answers: answerPack.answers.map(answer => ({
        id: answer.id,
        confidence: answer.confidence,
        evidence_count: answer.evidence.length,
        follow_up_tools: answer.follow_up_tools,
      })),
      gaps: answerPack.gaps,
    },
    recommended_first_tools: getAgentToolPlan(cas, { path, task }).steps.slice(0, 6),
    when_to_read_files: [
      'When get_coding_context names the exact file or node to edit.',
      'When an MCP answer reports a gap that needs direct verification.',
      'When tests, logs, or source diffs must be inspected to complete the user task.',
    ],
  };
}

export function getAgentWorkPacket(cas: CASOutput, path: string, taskInput: AgentTask = {}) {
  const task = normalizeTask(taskInput);
  const readiness = evaluateAgentReadiness(cas, path);
  const plan = getAgentToolPlan(cas, { path, task });
  const targetResolution = resolveTaskTarget(cas, task.target);
  const selectedNode = targetResolution.selected_node;
  const tests = selectedNode
    ? findTests(cas, { nodeId: selectedNode.id, limit: 10 })
    : findTests(cas, { limit: 10 });
  const callers = selectedNode ? getCallers(cas, selectedNode.id, 2, 25) : null;
  const callees = selectedNode ? getCallees(cas, selectedNode.id, 2, 25) : null;
  const risk = selectedNode ? assessChangeRisk(cas, selectedNode.id) : null;
  const codingContext = selectedNode || task.target
    ? getCodingContext(cas, selectedNode?.id || task.target || '', { task_type: workPacketTaskType(task.task_type) })
    : null;
  const errorContracts = selectedNode && task.task_type === 'debug'
    ? getErrorContracts(cas, selectedNode.id, 'both')
    : null;
  const entryContext = buildEntryContext(cas, task, selectedNode?.id);
  const fileReadPlan = buildFileReadPlan(cas, selectedNode || undefined, callers, callees, tests, entryContext);
  const gaps = [
    ...readiness.adoption_gaps,
    ...targetResolution.gaps,
    ...(fileReadPlan.length === 0 ? ['file-read-plan: no concrete source files resolved'] : []),
  ];

  return {
    path,
    generated_at: new Date().toISOString(),
    task,
    status: gaps.length === 0 ? 'ready' : 'needs-review',
    default_use: readiness.default_use,
    readiness: {
      status: readiness.status,
      score: readiness.score,
      gaps: readiness.adoption_gaps,
    },
    target_resolution: targetResolution,
    selected_node: selectedNode ? summarizeNodeForAgent(selectedNode) : null,
    work_context: {
      coding_context: codingContext,
      risk,
      callers,
      callees,
      tests,
      error_contracts: errorContracts,
      entry_context: entryContext,
    },
    file_read_plan: fileReadPlan,
    next_mcp_calls: plan.steps,
    source_reading_rule: 'Read only the files in file_read_plan first. Expand only when those files or MCP evidence show a concrete gap.',
    gaps,
  };
}

export function getAgentToolPlan(cas: CASOutput, input: { path: string; task?: AgentTask }) {
  const task = normalizeTask(input.task || {});
  const representativeNodeId = representativeTarget(cas)?.id;
  const target = task.target || representativeNodeId || 'target-query';
  const nodeId = representativeNodeId || '<node_id from search_nodes>';
  const entryPoint = (cas.entry_points || [])[0];
  const chain = (cas.call_chains || [])[0];
  const steps = stepsForTask(input.path, task, target, nodeId, entryPoint?.id, chain?.id);

  return {
    path: input.path,
    generated_at: new Date().toISOString(),
    task,
    rule: 'Use this plan before broad file reads. Source files are for targeted verification and edits after MCP identifies the relevant graph area.',
    steps,
    fallback: {
      condition: 'CAS analysis is missing, stale, or returns an error.',
      action: 'Run analyze_codebase. If the error remains, report the MCP/CAS failure and fall back to direct code reading for the task.',
    },
  };
}

function resolveTaskTarget(cas: CASOutput, target?: string) {
  const gaps: string[] = [];
  const candidateNodes = new Map<string, CASNode>();
  let selectedNode: CASNode | undefined;

  if (target) {
    const exactNode = cas.nodes.find(node => node.id === target);
    if (exactNode) {
      selectedNode = exactNode;
      candidateNodes.set(exactNode.id, exactNode);
    }

    const searched = searchNodes(cas, target, { limit: 10 })
      .map(result => cas.nodes.find(node => node.id === result.id))
      .filter((node): node is CASNode => Boolean(node));
    for (const node of searched) {
      candidateNodes.set(node.id, node);
    }

    const fileMatches = cas.nodes.filter(node =>
      node.source?.file &&
      (node.source.file.endsWith(target) || target.endsWith(node.source.file))
    ).slice(0, 10);
    for (const node of fileMatches) {
      candidateNodes.set(node.id, node);
    }

    const scoredCandidates = [...candidateNodes.values()]
      .map(node => ({ node, score: scoreNodeForTarget(node, target) }))
      .sort((left, right) => right.score - left.score);
    if (!selectedNode) selectedNode = scoredCandidates[0]?.node;

    if (!selectedNode) gaps.push(`target: no CAS node resolved for "${target}"`);
    if (scoredCandidates.length > 1 && scoredCandidates[0].score - scoredCandidates[1].score < 15) {
      gaps.push(`target: "${target}" is ambiguous; review candidate nodes before editing`);
    }

    return {
      query: target,
      selected_node_id: selectedNode?.id || null,
      selected_node: selectedNode || null,
      candidates: scoredCandidates.map(candidate => ({
        ...summarizeNodeForAgent(candidate.node),
        score: candidate.score,
      })),
      gaps,
    };
  } else {
    selectedNode = representativeTarget(cas);
    if (selectedNode) candidateNodes.set(selectedNode.id, selectedNode);
    else gaps.push('target: no representative CAS node available');
  }

  return {
    query: target || null,
    selected_node_id: selectedNode?.id || null,
    selected_node: selectedNode || null,
    candidates: [...candidateNodes.values()].map(node => ({
      ...summarizeNodeForAgent(node),
      score: scoreNodeForTarget(node, target),
    })),
    gaps,
  };
}

function scoreNodeForTarget(node: CASNode, target?: string): number {
  if (!target) return 50;
  const query = target.toLowerCase();
  const name = node.name.toLowerCase();
  const qualifiedName = node.qualified_name?.toLowerCase() || '';
  const file = node.source?.file?.toLowerCase() || '';
  let score = 0;

  if (node.id === target) score += 200;
  if (name === query) score += 120;
  if (name.startsWith(query)) score += 70;
  if (name.includes(query)) score += 45;
  if (qualifiedName.includes(query)) score += 30;
  if (file.includes(query)) score += 25;

  const preferredTypes = ['controller', 'service', 'guard', 'middleware', 'gateway', 'resolver', 'handler', 'route', 'api_route', 'react_page', 'custom_hook', 'function', 'method'];
  if (preferredTypes.includes(node.type)) score += 20;
  if (node.type === 'file' || node.type === 'import') score -= 100;
  if (node.type.toLowerCase().includes('dto')) score -= 20;
  if (node.name.toLowerCase().includes('dto')) score -= 20;

  return score;
}

function buildEntryContext(cas: CASOutput, task: Required<Pick<AgentTask, 'task_type'>> & AgentTask, nodeId?: string) {
  const relatedEntries = nodeId
    ? (cas.entry_points || []).filter(entry =>
        entry.source_node === nodeId ||
        entry.handler?.node_id === nodeId ||
        entry.connected_nodes?.includes(nodeId)
      )
    : [];
  const selectedEntry = relatedEntries[0] || (cas.entry_points || [])[0];
  const chains = selectedEntry
    ? getCallChain(cas, { entryPointId: selectedEntry.id, limit: 5 })
    : getCallChain(cas, { limit: 5 });

  return {
    task_type: task.task_type,
    related_entry_points: relatedEntries.slice(0, 5).map(entry => ({
      id: entry.id,
      name: entry.name,
      type: entry.type,
      trigger: entry.trigger,
      handler: entry.handler,
    })),
    representative_entry_point: selectedEntry ? {
      id: selectedEntry.id,
      name: selectedEntry.name,
      type: selectedEntry.type,
      trigger: selectedEntry.trigger,
      handler: selectedEntry.handler,
    } : null,
    call_chains: chains,
  };
}

function buildFileReadPlan(
  cas: CASOutput,
  selectedNode: CASNode | undefined,
  callers: ReturnType<typeof getCallers> | null,
  callees: ReturnType<typeof getCallees> | null,
  tests: ReturnType<typeof findTests>,
  entryContext: ReturnType<typeof buildEntryContext>
): FileReadPlanItem[] {
  const items = new Map<string, FileReadPlanItem>();
  const rootPath = cas.system?.root_path;
  const addNode = (node: CASNode | undefined, reason: string) => {
    if (!node?.source?.file) return;
    const file = normalizeSourceFile(node.source.file, rootPath);
    const existing = items.get(file);
    if (existing) {
      if (!existing.node_ids.includes(node.id)) existing.node_ids.push(node.id);
      if (!existing.reason.includes(reason)) existing.reason = `${existing.reason}; ${reason}`;
      return;
    }
    items.set(file, {
      file,
      reason,
      node_ids: [node.id],
      line: node.source.line,
    });
  };

  addNode(selectedNode, 'selected target');

  for (const caller of callers?.callers.slice(0, 5) || []) {
    addNode(cas.nodes.find(node => node.id === caller.node_id), `caller via ${caller.via}`);
  }

  for (const callee of callees?.callees.slice(0, 5) || []) {
    addNode(cas.nodes.find(node => node.id === callee.node_id), `callee via ${callee.via}`);
  }

  for (const suite of (tests.suites || []).slice(0, 5) as Array<{ file_path?: string; name?: string }>) {
    if (!suite.file_path) continue;
    const file = normalizeSourceFile(suite.file_path, rootPath);
    const existing = items.get(file);
    if (existing) {
      if (!existing.reason.includes('test coverage')) existing.reason = `${existing.reason}; test coverage`;
    } else {
      items.set(file, {
        file,
        reason: `test coverage${suite.name ? `: ${suite.name}` : ''}`,
        node_ids: [],
      });
    }
  }

  const representativeEntry = entryContext.representative_entry_point;
  if (representativeEntry?.handler?.file) {
    const file = normalizeSourceFile(representativeEntry.handler.file, rootPath);
    const existing = items.get(file);
    if (existing) {
      if (!existing.reason.includes('representative entry point')) existing.reason = `${existing.reason}; representative entry point`;
    } else {
      items.set(file, {
        file,
        reason: 'representative entry point',
        node_ids: representativeEntry.handler.node_id ? [representativeEntry.handler.node_id] : [],
        line: representativeEntry.handler.line,
      });
    }
  }

  return [...items.values()].slice(0, 12);
}

function normalizeSourceFile(file: string, rootPath?: string): string {
  const normalizedFile = file.replace(/\\/g, '/');
  if (!rootPath) return normalizedFile.replace(/^\.\//, '');
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalizedFile.startsWith(`${normalizedRoot}/`)) {
    return normalizedFile.slice(normalizedRoot.length + 1);
  }
  return normalizedFile.replace(/^\.\//, '');
}

function summarizeNodeForAgent(node: CASNode) {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    qualified_name: node.qualified_name,
    file: node.source?.file,
    line: node.source?.line,
    level: node.level,
    category: node.category,
    tags: node.tags,
  };
}

function workPacketTaskType(taskType?: AgentTaskType): 'add' | 'modify' | 'delete' | 'refactor' {
  if (taskType === 'review' || taskType === 'trace' || taskType === 'runtime' || taskType === 'cross-repo' || taskType === 'orient') return 'modify';
  if (taskType === 'debug') return 'modify';
  return 'modify';
}

export function evaluateAgentReadiness(cas: CASOutput, path: string): AgentReadinessReport {
  const summary = buildSummary(cas);
  const answerPack = runAnswerPack(cas, path);
  const methodCalls = cas.method_calls?.length || cas.nodes.reduce((total, node) => total + (node.call_graph?.calls?.length || 0), 0);
  const tests = findTests(cas, { limit: 1 });
  const security = getSecurityOverview(cas);
  const flowCoverage = getFlowCoverage(cas) as Record<string, unknown>;
  const graphIntegrity = cas.validation?.graph_integrity;
  const runtimeLinks = cas.runtime_static_links?.length || 0;
  const facts = cas.analysis_facts?.length || 0;
  const analysisErrors = cas.analysis_errors?.length || 0;
  const gates: AgentReadinessGate[] = [
    gate('analysis-errors', analysisErrors === 0 ? 'pass' : 'fail', analysisErrors === 0 ? 100 : 0, `${analysisErrors} analysis errors`),
    gate('nodes', cas.nodes.length > 0 ? 'pass' : 'fail', cas.nodes.length > 0 ? 100 : 0, `${cas.nodes.length} nodes`),
    gate('edges', cas.edges.length > 0 ? 'pass' : 'fail', cas.edges.length > 0 ? 100 : 0, `${cas.edges.length} edges`),
    coverageGate('entry-points', cas.entry_points?.length || 0, minimumEntryPointCount(cas)),
    coverageGate('call-chains', cas.call_chains?.length || 0, minimumCallChainCount(cas)),
    relationshipDetailGate(cas, methodCalls),
    gate('answer-pack', answerPack.gaps.length === 0 ? 'pass' : 'warn', answerPack.gaps.length === 0 ? 100 : 75, answerPack.gaps.length === 0 ? 'Mastery answer pack has no gaps' : answerPack.gaps.join('; ')),
    gate('evidence', facts > 0 ? 'pass' : 'warn', facts > 0 ? 100 : 75, `${facts} analysis facts`),
    gate('tests', tests.total_suites > 0 ? 'pass' : 'warn', tests.total_suites > 0 ? 100 : 80, `${tests.total_suites} test suites detected`),
    gate('security', security.boundary_count > 0 || security.context_count > 0 ? 'pass' : 'warn', security.boundary_count > 0 || security.context_count > 0 ? 100 : 80, `${security.boundary_count || 0} boundaries, ${security.context_count || 0} contexts`),
    gate('runtime-correlation', runtimeLinks > 0 ? 'pass' : 'warn', runtimeLinks > 0 ? 100 : 80, `${runtimeLinks} runtime static links`),
    gate('flow-coverage', hasFlowCoverage(flowCoverage) ? 'pass' : 'warn', hasFlowCoverage(flowCoverage) ? 100 : 80, flowCoverageDetail(flowCoverage)),
  ];

  if (graphIntegrity) {
    const graphScore = normalizeScore(graphIntegrity.relationship_coverage_score);
    const danglingCoverage = graphIntegrity.total_edges <= 0 ? 100 : ((graphIntegrity.total_edges - graphIntegrity.dangling_edges) / graphIntegrity.total_edges) * 100;
    gates.push(gate(
      'graph-integrity',
      graphScore >= 85 && danglingCoverage >= 95 ? 'pass' : graphScore >= 70 && danglingCoverage >= 85 ? 'warn' : 'fail',
      Math.min(graphScore, danglingCoverage),
      `${graphIntegrity.connected_nodes} connected, ${graphIntegrity.orphaned_nodes} orphaned, ${graphIntegrity.dangling_edges} dangling`
    ));
    gates.push(gate(
      'entry-handler-coverage',
      cas.entry_points?.length ? statusForRatio(graphIntegrity.entry_points_with_handlers, cas.entry_points.length, 0.95, 0.8) : 'pass',
      ratioScore(graphIntegrity.entry_points_with_handlers, cas.entry_points?.length || 0),
      `${graphIntegrity.entry_points_with_handlers}/${cas.entry_points?.length || 0}`
    ));
    gates.push(gate(
      'exit-source-coverage',
      cas.exit_points?.length ? statusForRatio(graphIntegrity.exit_points_with_sources, cas.exit_points.length, 0.95, 0.8) : 'pass',
      ratioScore(graphIntegrity.exit_points_with_sources, cas.exit_points?.length || 0),
      `${graphIntegrity.exit_points_with_sources}/${cas.exit_points?.length || 0}`
    ));
  } else {
    gates.push(gate('graph-integrity', 'fail', 0, 'Missing validation.graph_integrity'));
  }

  const score = Math.round(gates.reduce((sum, result) => sum + result.score, 0) / gates.length);
  const status: GateStatus = gates.some(result => result.status === 'fail')
    ? 'fail'
    : gates.some(result => result.status === 'warn') ? 'warn' : 'pass';
  const adoptionGaps = gates
    .filter(result => result.status !== 'pass')
    .sort((left, right) => left.score - right.score)
    .slice(0, 8)
    .map(result => `${result.id}: ${result.detail}`);

  return {
    path,
    name: summary.name || path.split('/').pop() || path,
    generated_at: new Date().toISOString(),
    status,
    score,
    default_use: status !== 'fail' && score >= 85,
    summary: {
      nodes: cas.nodes.length,
      edges: cas.edges.length,
      entry_points: cas.entry_points?.length || 0,
      exit_points: cas.exit_points?.length || 0,
      call_chains: cas.call_chains?.length || 0,
      method_calls: methodCalls,
      runtime_static_links: runtimeLinks,
      analysis_facts: facts,
      tests: tests.total_suites,
      analysis_errors: analysisErrors,
    },
    gates,
    adoption_gaps: adoptionGaps,
    required_agent_behavior: [
      'Call get_agent_start_context before broad file reads when an analysis exists.',
      'Call get_agent_tool_plan for the user task before choosing MCP queries.',
      'Call get_coding_context before code edits in a targeted area.',
      'Use assess_change_risk and find_tests before landing changes that touch connected behavior.',
      'Report CAS/MCP errors as blockers to default use and then fall back to direct code reading.',
    ],
  };
}

function normalizeTask(task: AgentTask): Required<Pick<AgentTask, 'task_type'>> & AgentTask {
  return {
    ...task,
    task_type: task.task_type || 'orient',
  };
}

function stepsForTask(path: string, task: Required<Pick<AgentTask, 'task_type'>> & AgentTask, target: string, nodeId: string, entryPointId?: string, chainId?: string): AgentToolStep[] {
  const base: AgentToolStep[] = [
    step(1, 'get_agent_start_context', { path, task }, 'Load the CAS-backed default context and readiness status.', true),
    step(2, 'get_agent_tool_plan', { path, task }, 'Select task-specific MCP calls before file reads.', true),
  ];

  if (task.task_type === 'modify') {
    return [
      ...base,
      step(3, 'search_nodes', { path, query: task.target || target, limit: 10 }, 'Resolve the target to a concrete CAS node.', true),
      step(4, 'get_coding_context', { path, target, task_type: 'modify' }, 'Load conventions, connected code, and modification checklist.', true),
      step(5, 'assess_change_risk', { path, node_id: task.target ? '<node_id from search_nodes>' : nodeId }, 'Assess blast radius before editing.', true),
      step(6, 'find_tests', { path, node_id: task.target ? '<node_id from search_nodes>' : nodeId, limit: 10 }, 'Find direct test coverage and nearby tests.', true),
      step(7, 'get_callers', { path, node_id: task.target ? '<node_id from search_nodes>' : nodeId, depth: 2, limit: 25 }, 'Check upstream dependents.', false),
      step(8, 'get_callees', { path, node_id: task.target ? '<node_id from search_nodes>' : nodeId, depth: 2, limit: 25 }, 'Check downstream dependencies.', false),
    ];
  }

  if (task.task_type === 'debug') {
    return [
      ...base,
      step(3, 'correlate_runtime_event', { path, event: task.runtime_event || { type: 'error', signal: task.target } }, 'Map runtime symptoms to CAS when an event or stack is available.', false),
      step(4, 'search_nodes', { path, query: task.target || target, limit: 10 }, 'Find likely code areas for the symptom.', true),
      step(5, 'get_error_contracts', { path, node_id: task.target ? '<node_id from search_nodes>' : nodeId, direction: 'both' }, 'Inspect error behavior and propagation.', false),
      step(6, 'get_call_chain', { path, entry_point_id: entryPointId, limit: 10 }, 'Trace the relevant behavior from entry point to exit.', false),
      step(7, 'get_coding_context', { path, target, task_type: 'modify' }, 'Load targeted context before changing code.', true),
      step(8, 'find_tests', { path, node_id: task.target ? '<node_id from search_nodes>' : nodeId, limit: 10 }, 'Find tests that should reproduce or guard the fix.', true),
    ];
  }

  if (task.task_type === 'review') {
    return [
      ...base,
      step(3, 'run_answer_pack', { path, pack: 'mastery' }, 'Verify the core explanations still answer cleanly.', true),
      step(4, 'get_change_summary', { path, group_by: 'file' }, 'Summarize recent CAS change history.', false),
      step(5, 'get_hot_spots', { path, limit: 20 }, 'Find risky churn areas.', false),
      step(6, 'get_flow_coverage', { path }, 'Check flow-level test protection.', true),
      step(7, 'get_security_overview', { path }, 'Review security boundaries and enforcement.', true),
    ];
  }

  if (task.task_type === 'trace') {
    return [
      ...base,
      step(3, 'get_entry_points', { path, limit: 20 }, 'Choose the behavior input to trace.', true),
      step(4, 'get_call_chain', { path, entry_point_id: entryPointId, chain_id: chainId, limit: 10 }, 'Trace from entry to downstream calls and exits.', true),
      step(5, 'get_exit_points', { path, limit: 20 }, 'Inspect external boundaries reached by the trace.', false),
      step(6, 'get_runtime_static_links', { path, limit: 20 }, 'Find runtime signals that can confirm the static trace.', false),
    ];
  }

  if (task.task_type === 'cross-repo') {
    return [
      ...base,
      step(3, 'list_analyses', {}, 'See which repositories already have CAS output.', true),
      step(4, 'get_cross_repo_links', { paths: [path, ...(task.related_paths || [])] }, 'Detect APIs, shared data stores, messages, and shared libraries across repos.', true),
      step(5, 'run_answer_pack', { path, pack: 'mastery' }, 'Explain the primary repo with evidence.', true),
    ];
  }

  if (task.task_type === 'runtime') {
    return [
      ...base,
      step(3, 'get_runtime_static_links', { path, limit: 25 }, 'List runtime signals and instrumentation candidates.', true),
      step(4, 'correlate_runtime_event', { path, event: task.runtime_event || { type: 'request', signal: task.target } }, 'Map runtime data back to CAS.', false),
      step(5, 'get_runtime_observations', { path, limit: 25 }, 'Read stored runtime observations and correlations.', false),
      step(6, 'run_answer_pack', { path, pack: 'mastery' }, 'Check whether runtime readiness remains explainable.', true),
    ];
  }

  return [
    ...base,
    step(3, 'run_answer_pack', { path, pack: 'mastery' }, 'Answer core codebase questions with evidence.', true),
    step(4, 'get_summary', { path }, 'Read condensed architecture and capability summary.', true),
    step(5, 'get_entry_points', { path, limit: 15 }, 'Inspect concrete inputs into the system.', false),
    step(6, 'get_flow_graph', { path }, 'Inspect capability-level behavior and dependencies.', false),
  ];
}

function step(order: number, tool: string, args: Record<string, unknown>, purpose: string, required: boolean): AgentToolStep {
  return { order, tool, args, purpose, required };
}

function gate(id: string, status: GateStatus, score: number, detail: string): AgentReadinessGate {
  return { id, status, score: Math.round(Math.max(0, Math.min(100, score))), detail };
}

function coverageGate(id: string, actual: number, minimum: number): AgentReadinessGate {
  const score = ratioScore(actual, minimum);
  return gate(id, statusForScore(score), score, `${actual}/${minimum}`);
}

function relationshipDetailGate(cas: CASOutput, methodCalls: number): AgentReadinessGate {
  const callChains = cas.call_chains?.length || 0;
  const edges = cas.edges.length;
  if (methodCalls >= 10) return gate('relationship-detail', 'pass', 100, `${methodCalls} method calls`);
  if (callChains > 0 && edges > 0) {
    return gate('relationship-detail', 'warn', 90, `${methodCalls} method calls, ${callChains} call chains, ${edges} edges`);
  }
  return coverageGate('relationship-detail', methodCalls, cas.nodes.length > 25 ? 10 : 1);
}

function ratioScore(actual: number, expected: number): number {
  if (expected <= 0) return 100;
  return Math.min(100, (actual / expected) * 100);
}

function statusForScore(score: number): GateStatus {
  if (score >= 100) return 'pass';
  if (score >= 70) return 'warn';
  return 'fail';
}

function statusForRatio(actual: number, expected: number, pass: number, warn: number): GateStatus {
  if (expected <= 0) return 'pass';
  const value = actual / expected;
  if (value >= pass) return 'pass';
  if (value >= warn) return 'warn';
  return 'fail';
}

function normalizeScore(value: number): number {
  return value > 1 ? Math.max(0, Math.min(100, value)) : Math.max(0, Math.min(100, value * 100));
}

function minimumEntryPointCount(cas: CASOutput): number {
  if (cas.system?.type === 'library' || cas.nodes.length < 10) return 0;
  return 1;
}

function minimumCallChainCount(cas: CASOutput): number {
  const entryPoints = cas.entry_points?.length || 0;
  if (entryPoints === 0) return 0;
  return Math.max(1, Math.ceil(entryPoints * 0.35));
}

function mostConnectedNodes(cas: CASOutput): CASNode[] {
  const counts = new Map<string, number>();
  for (const edge of cas.edges) {
    counts.set(edge.source, (counts.get(edge.source) || 0) + 1);
    counts.set(edge.target, (counts.get(edge.target) || 0) + 1);
  }
  for (const call of cas.method_calls || []) {
    if (call.caller_node) counts.set(call.caller_node, (counts.get(call.caller_node) || 0) + 1);
    if (call.target_node) counts.set(call.target_node, (counts.get(call.target_node) || 0) + 1);
  }

  return [...cas.nodes]
    .filter(node => node.type !== 'file' && node.type !== 'import')
    .sort((left, right) => (counts.get(right.id) || 0) - (counts.get(left.id) || 0));
}

function representativeTarget(cas: CASOutput): CASNode | undefined {
  return mostConnectedNodes(cas)[0] || cas.nodes[0];
}

function hasFlowCoverage(flowCoverage: Record<string, unknown>): boolean {
  const keys = Object.keys(flowCoverage);
  if (keys.length === 0) return false;
  return keys.some(key => {
    const value = flowCoverage[key];
    if (typeof value === 'number') return value > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return Boolean(value);
  });
}

function flowCoverageDetail(flowCoverage: Record<string, unknown>): string {
  const keys = Object.keys(flowCoverage);
  if (keys.length === 0) return 'No flow coverage summary';
  return keys.slice(0, 5).map(key => `${key}=${JSON.stringify(flowCoverage[key])}`).join(', ');
}
