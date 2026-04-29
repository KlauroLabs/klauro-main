import * as fs from 'fs';
import * as nodePath from 'path';
import type { CASEntryPoint, CASOutput, CASNode } from '../../backend/src/types/cas.types';
import {
  assessChangeRisk,
  buildSummary,
  findTests,
  getCallees,
  getCallChain,
  getCallers,
  getBehavioralInvariants,
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
import type { TestDiscoveryEvidence } from './test-discovery';

export type AgentTaskType = 'orient' | 'modify' | 'debug' | 'review' | 'trace' | 'cross-repo' | 'runtime';
type GateStatus = 'pass' | 'warn' | 'fail';

export interface AgentTask {
  task_type?: AgentTaskType;
  target?: string;
  related_paths?: string[];
  runtime_event?: Record<string, unknown>;
  instructions?: string;
  success_criteria?: string[];
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
    behavioral_invariants?: {
      total: number;
      gaps: number;
    };
    test_discovery?: {
      status: string;
      source_test_files: number;
      potential_uncovered_test_files: number;
    };
  };
  gates: AgentReadinessGate[];
  adoption_gaps: string[];
  required_agent_behavior: string[];
  test_discovery?: TestDiscoveryEvidence;
}

interface FileReadPlanItem {
  file: string;
  reason: string;
  node_ids: string[];
  line?: number;
}

interface AgentTestSuiteRef {
  file_path?: string;
  name?: string;
}

interface AgentValidationCommand {
  command: string;
  purpose: string;
  scope: 'focused-test' | 'typecheck' | 'build' | 'broad-test';
  files?: string[];
  confidence: number;
}

interface AgentValidationPlan {
  strategy: string;
  commands: AgentValidationCommand[];
  tests_to_inspect: Array<{ file: string; name?: string; reason: string }>;
  manual_checks: string[];
  environment_rule: string;
  gaps: string[];
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
  const behavioralInvariants = getBehavioralInvariants(cas, {
    target: selectedNode?.id || task.target,
    limit: 12,
  });
  const entryContext = buildEntryContext(cas, task, selectedNode?.id);
  const fileReadPlan = buildFileReadPlan(cas, selectedNode || undefined, callers, callees, tests, entryContext);
  const validationPlan = buildValidationPlan(path, cas, task, selectedNode || undefined, tests, fileReadPlan, risk, behavioralInvariants);
  const gaps = [
    ...readiness.adoption_gaps,
    ...targetResolution.gaps,
    ...(fileReadPlan.length === 0 ? ['file-read-plan: no concrete source files resolved'] : []),
    ...validationPlan.gaps.map(gap => `validation-plan: ${gap}`),
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
      behavioral_invariants: behavioralInvariants,
      entry_context: entryContext,
    },
    file_read_plan: fileReadPlan,
    validation_plan: validationPlan,
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

    const naturalMatches = cas.nodes
      .map(node => ({ node, score: scoreNodeForTarget(node, target) }))
      .filter(candidate => candidate.score >= 55)
      .sort((left, right) => right.score - left.score)
      .slice(0, 10)
      .map(candidate => candidate.node);
    for (const node of naturalMatches) {
      candidateNodes.set(node.id, node);
    }

    const routeMatches = (cas.entry_points || [])
      .filter(entry => entryPointMatchesTarget(entry, target))
      .flatMap(entry => [entry.source_node, entry.handler?.node_id].filter(Boolean) as string[])
      .map(nodeId => cas.nodes.find(node => node.id === nodeId))
      .filter((node): node is CASNode => Boolean(node));
    for (const node of routeMatches) {
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
  const targetTokens = meaningfulTokens(target);
  const nodeTokens = meaningfulTokens([
    node.name,
    node.qualified_name,
    node.source?.file,
    node.description,
    ...(node.tags || []),
  ].filter(Boolean).join(' '));
  const normalizedQuery = normalizeIdentifier(target);
  const normalizedName = normalizeIdentifier(node.name);
  let score = 0;

  if (node.id === target) score += 200;
  if (name === query) score += 120;
  if (name.startsWith(query)) score += 70;
  if (name.includes(query)) score += 45;
  if (qualifiedName.includes(query)) score += 30;
  if (file.includes(query)) score += 25;
  if (normalizedName.length >= 6 && normalizedQuery.includes(normalizedName)) score += 85;

  const matchedTokens = targetTokens.filter(token =>
    nodeTokens.some(nodeToken => nodeToken === token || nodeToken.includes(token) || (token.length >= 5 && token.includes(nodeToken)))
  );
  if (matchedTokens.length > 0) {
    score += matchedTokens.length * 14;
    score += Math.round((matchedTokens.length / Math.max(1, targetTokens.length)) * 45);
  }
  const nodeNameTokens = meaningfulTokens(node.name);
  if (nodeNameTokens.length > 1 && nodeNameTokens.every(token => targetTokens.includes(token))) {
    score += 60;
  }

  const preferredTypes = ['controller', 'service', 'guard', 'middleware', 'gateway', 'resolver', 'handler', 'route', 'api_route', 'react_page', 'custom_hook', 'function', 'method'];
  if (preferredTypes.includes(node.type)) score += 20;
  if (node.type === 'file' || node.type === 'import') score -= 100;
  if (node.type === 'mock') score -= 90;
  if (node.type === 'test' || node.category === 'test' || node.source?.file?.toLowerCase().includes('.spec.')) score -= 45;
  if (node.type === 'property' || node.type === 'variable') score -= 45;
  if (node.type.toLowerCase().includes('dto')) score -= 20;
  if (node.name.toLowerCase().includes('dto')) score -= 20;

  return score;
}

function meaningfulTokens(value: string): string[] {
  const stopwords = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'by', 'with', 'when', 'from', 'into', 'must', 'should', 'only', 'same', 'different', 'uniqueness', 'unique']);
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(token => token.length >= 2 && !stopwords.has(token));
}

function normalizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
}

function entryPointMatchesTarget(entry: CASEntryPoint, target: string): boolean {
  const query = target.toLowerCase();
  const route = entry.trigger?.path || '';
  return entry.id === target ||
    entry.name.toLowerCase().includes(query) ||
    Boolean(route && routesCompatibleForAgent(route, target));
}

function routesCompatibleForAgent(actual: string, expected: string): boolean {
  const left = normalizeRouteForAgent(actual);
  const right = normalizeRouteForAgent(expected);
  if (left === right) return true;
  const leftParts = left.split('/').filter(Boolean);
  const rightParts = right.split('/').filter(Boolean);
  if (leftParts.length !== rightParts.length) return left.endsWith(right) || right.endsWith(left);
  return leftParts.every((part, index) => part === rightParts[index] || part === ':param' || rightParts[index] === ':param');
}

function normalizeRouteForAgent(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/[?#].*$/, '')
    .replace(/\[[^\]]+\]/g, ':param')
    .replace(/:[a-z0-9_]+/g, ':param')
    .replace(/\{[^}]+\}/g, ':param')
    .replace(/\$\{[^}]+\}/g, ':param')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
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

  const testSuites = uniqueTestSuites([
    ...((tests.suites || []).slice(0, 5) as AgentTestSuiteRef[]),
    ...inferRelatedTestSuites(cas, selectedNode),
  ]).slice(0, 8);

  for (const suite of testSuites) {
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

function buildValidationPlan(
  projectPath: string,
  cas: CASOutput,
  task: Required<Pick<AgentTask, 'task_type'>> & AgentTask,
  selectedNode: CASNode | undefined,
  tests: ReturnType<typeof findTests>,
  fileReadPlan: FileReadPlanItem[],
  risk: ReturnType<typeof assessChangeRisk> | null,
  behavioralInvariants: ReturnType<typeof getBehavioralInvariants>
): AgentValidationPlan {
  const scripts = readPackageScripts(projectPath);
  const testFiles = uniqueStrings([
    ...(tests.suites || []).map((suite: AgentTestSuiteRef) => suite.file_path).filter((file): file is string => Boolean(file)),
    ...fileReadPlan
      .filter(item => isTestPath(item.file))
      .map(item => item.file),
  ].map(file => normalizeValidationFile(projectPath, file))).slice(0, 8);
  const commands: AgentValidationCommand[] = [];
  const focusedTestCommand = buildFocusedTestCommand(projectPath, scripts, testFiles);
  if (focusedTestCommand) {
    commands.push({
      command: focusedTestCommand,
      purpose: testFiles.length > 0 ? 'Run tests that cover or sit next to the selected target.' : 'Run the repository test script because no focused test file was resolved.',
      scope: testFiles.length > 0 ? 'focused-test' : 'broad-test',
      files: testFiles,
      confidence: testFiles.length > 0 ? 0.9 : 0.58,
    });
  }

  const typecheckCommand = buildScriptCommand(scripts, ['typecheck', 'type-check', 'check', 'tsc']);
  if (typecheckCommand && typecheckCommand !== focusedTestCommand) {
    commands.push({
      command: typecheckCommand,
      purpose: 'Verify type contracts after the edit.',
      scope: 'typecheck',
      confidence: 0.78,
    });
  }

  const buildCommand = buildScriptCommand(scripts, ['build']);
  if (buildCommand && task.task_type !== 'orient') {
    commands.push({
      command: buildCommand,
      purpose: 'Verify the package still builds when the touched files are compile-time sensitive.',
      scope: 'build',
      confidence: 0.64,
    });
  }

  const manualChecks = [
    selectedNode ? `Confirm the edit preserves the contract of ${selectedNode.name}.` : 'Confirm the edit target was resolved before changing source files.',
    ...(task.success_criteria || []).map(criterion => `Verify success criterion: ${criterion}`),
    ...behavioralInvariants.invariants.slice(0, 6).map((invariant: any) => `Preserve invariant: ${invariant.name} - ${invariant.description}`),
  ];
  const riskReasons = risk?.risk
    ? [
      risk.risk.risk_level ? `Risk level is ${risk.risk.risk_level}.` : '',
      ...(risk.risk.risk_factors || []).map(factor => `${factor.factor}: ${factor.details}`),
      ...(risk.risk.recommendations || []),
    ].filter(Boolean)
    : [];
  manualChecks.push(...riskReasons.slice(0, 4));

  const testsToInspect = testFiles.map(file => ({
    file,
    name: (tests.suites || []).find((suite: AgentTestSuiteRef) => suite.file_path === file)?.name,
    reason: 'Use this as the focused validation surface before broad test exploration.',
  }));

  return {
    strategy: testFiles.length > 0
      ? 'focused-tests-first'
      : commands.length > 0 ? 'repo-script-fallback' : 'manual-validation-required',
    commands: commands.slice(0, 4),
    tests_to_inspect: testsToInspect,
    manual_checks: uniqueStrings(manualChecks).slice(0, 8),
    environment_rule: 'Do not install dependencies or run broad environment setup unless the task explicitly asks for it. If focused validation cannot run in the existing checkout, report that as an environment blocker.',
    gaps: commands.length === 0 ? ['no runnable validation command inferred from package scripts or test files'] : [],
  };
}

function readPackageScripts(projectPath: string): Record<string, string> {
  const packagePath = nodePath.join(projectPath, 'package.json');
  if (!fs.existsSync(packagePath)) return {};
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return pkg && typeof pkg === 'object' && pkg.scripts && typeof pkg.scripts === 'object'
      ? pkg.scripts
      : {};
  } catch {
    return {};
  }
}

function buildFocusedTestCommand(projectPath: string, scripts: Record<string, string>, testFiles: string[]): string | null {
  if (testFiles.length === 0) {
    return buildScriptCommand(scripts, ['test']);
  }
  const quotedFiles = testFiles.map(shellQuoteForAgent).join(' ');
  const testScript = pickScript(scripts, ['test:unit', 'unit', 'test']);
  if (testScript) {
    return scriptCommand(testScript, true, quotedFiles);
  }
  const first = testFiles[0];
  if (first.endsWith('.py')) return `pytest ${quotedFiles}`;
  if (first.endsWith('.go')) return `go test ${uniqueGoPackages(projectPath, testFiles).join(' ')}`;
  if (first.endsWith('.rs')) return 'cargo test';
  if (first.match(/\.[cm]?[jt]sx?$/)) return `npm test -- ${quotedFiles}`;
  return null;
}

function buildScriptCommand(scripts: Record<string, string>, preferred: string[]): string | null {
  const script = pickScript(scripts, preferred);
  return script ? scriptCommand(script, false) : null;
}

function pickScript(scripts: Record<string, string>, preferred: string[]): string | null {
  for (const name of preferred) {
    if (scripts[name]) return name;
  }
  return null;
}

function scriptCommand(script: string, passFiles: boolean, files = ''): string {
  const base = script === 'test' ? 'npm test' : `npm run ${script}`;
  return passFiles ? `${base} -- ${files}` : base;
}

function uniqueGoPackages(projectPath: string, testFiles: string[]): string[] {
  return uniqueStrings(testFiles.map(file => {
    const directory = nodePath.dirname(nodePath.resolve(projectPath, file));
    const relative = nodePath.relative(projectPath, directory).replace(/\\/g, '/');
    return relative ? `./${relative}` : './...';
  }));
}

function shellQuoteForAgent(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeValidationFile(projectPath: string, file: string): string {
  const normalizedFile = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const normalizedRoot = projectPath.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalizedFile.startsWith(`${normalizedRoot}/`)) {
    return normalizedFile.slice(normalizedRoot.length + 1);
  }
  return normalizedFile;
}

function isTestPath(file: string): boolean {
  return /(\.(spec|test)\.[cm]?[jt]sx?|_test\.(py|go|rs)|\.test\.py)$/i.test(file);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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

function inferRelatedTestSuites(cas: CASOutput, selectedNode?: CASNode): AgentTestSuiteRef[] {
  if (!selectedNode?.source?.file) return [];
  const rootPath = cas.system?.root_path;
  const sourceFile = normalizeSourceFile(selectedNode.source.file, rootPath);
  const sourceStem = pathStem(sourceFile);
  const colocatedCandidates = colocatedTestCandidates(sourceFile);

  return ((cas.test_suites || []) as AgentTestSuiteRef[]).filter(suite => {
    if (!suite.file_path) return false;
    const testFile = normalizeSourceFile(suite.file_path, rootPath);
    if (colocatedCandidates.some(candidate => projectPathsMatch(testFile, candidate))) return true;
    return Boolean(sourceStem && pathStem(testFile) === sourceStem);
  });
}

function uniqueTestSuites(suites: AgentTestSuiteRef[]): AgentTestSuiteRef[] {
  const seen = new Set<string>();
  const unique: AgentTestSuiteRef[] = [];
  for (const suite of suites) {
    const key = suite.file_path || suite.name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(suite);
  }
  return unique;
}

function colocatedTestCandidates(sourceFile: string): string[] {
  return [
    sourceFile.replace(/\.([cm]?[jt]sx?)$/, '.spec.$1'),
    sourceFile.replace(/\.([cm]?[jt]sx?)$/, '.test.$1'),
  ];
}

function projectPathsMatch(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const normalizedRight = right.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return normalizedLeft === normalizedRight || normalizedLeft.endsWith(`/${normalizedRight}`) || normalizedRight.endsWith(`/${normalizedLeft}`);
}

function pathStem(file: string): string {
  const base = file.split('/').pop() || file;
  return base
    .replace(/\.(spec|test)\.([cm]?[jt]sx?)$/i, '')
    .replace(/\.([cm]?[jt]sx?)$/i, '')
    .toLowerCase();
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

export function evaluateAgentReadiness(cas: CASOutput, path: string, opts: { testEvidence?: TestDiscoveryEvidence } = {}): AgentReadinessReport {
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
  const testGate = testReadinessGate(tests.total_suites, opts.testEvidence);
  const invariantGapCount = cas.behavioral_invariant_summary?.gaps?.length || 0;
  const gates: AgentReadinessGate[] = [
    gate('analysis-errors', analysisErrors === 0 ? 'pass' : 'fail', analysisErrors === 0 ? 100 : 0, `${analysisErrors} analysis errors`),
    gate('nodes', cas.nodes.length > 0 ? 'pass' : 'fail', cas.nodes.length > 0 ? 100 : 0, `${cas.nodes.length} nodes`),
    gate('edges', cas.edges.length > 0 ? 'pass' : 'fail', cas.edges.length > 0 ? 100 : 0, `${cas.edges.length} edges`),
    coverageGate('entry-points', cas.entry_points?.length || 0, minimumEntryPointCount(cas)),
    coverageGate('call-chains', cas.call_chains?.length || 0, minimumCallChainCount(cas)),
    relationshipDetailGate(cas, methodCalls),
    gate('answer-pack', answerPack.gaps.length === 0 ? 'pass' : 'warn', answerPack.gaps.length === 0 ? 100 : 75, answerPack.gaps.length === 0 ? 'Mastery answer pack has no gaps' : answerPack.gaps.join('; ')),
    gate('evidence', facts > 0 ? 'pass' : 'warn', facts > 0 ? 100 : 75, `${facts} analysis facts`),
    gate(
      'behavioral-invariants',
      (cas.behavioral_invariants?.length || 0) > 0 ? invariantGapCount > 0 ? 'warn' : 'pass' : 'warn',
      (cas.behavioral_invariants?.length || 0) > 0 ? invariantGapCount > 0 ? 82 : 100 : 70,
      (cas.behavioral_invariants?.length || 0) > 0
        ? `${cas.behavioral_invariants?.length || 0} behavior-level invariants, ${invariantGapCount} gaps`
        : 'No behavior-level invariants inferred'
    ),
    testGate,
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
      behavioral_invariants: cas.behavioral_invariant_summary ? {
        total: cas.behavioral_invariant_summary.total,
        gaps: cas.behavioral_invariant_summary.gaps.length,
      } : undefined,
      test_discovery: opts.testEvidence ? {
        status: opts.testEvidence.status,
        source_test_files: opts.testEvidence.source_test_files,
        potential_uncovered_test_files: opts.testEvidence.potential_uncovered_test_files.length,
      } : undefined,
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
    test_discovery: opts.testEvidence,
  };
}

function testReadinessGate(totalSuites: number, evidence?: TestDiscoveryEvidence): AgentReadinessGate {
  if (totalSuites > 0 && (!evidence || evidence.status === 'cas-covered')) {
    return gate('tests', 'pass', 100, `${totalSuites} test suites detected`);
  }
  if (totalSuites > 0 && evidence?.status === 'cas-partial') {
    return gate('tests', 'warn', 88, `${totalSuites} test suites detected; ${evidence.potential_uncovered_test_files.length} source test files are not represented in CAS`);
  }
  if (evidence?.status === 'potential-tests-missing-from-cas') {
    return gate('tests', 'warn', 65, `0 CAS test suites; ${evidence.source_test_files} source test files found but not represented in CAS`);
  }
  if (evidence?.status === 'no-source-tests-found') {
    return gate('tests', 'pass', 100, '0 CAS test suites; no source test files found in repository scan');
  }
  return gate('tests', 'warn', 80, `${totalSuites} test suites detected`);
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
