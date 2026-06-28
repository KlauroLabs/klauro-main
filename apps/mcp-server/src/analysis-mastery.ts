import * as fs from 'fs-extra';
import * as path from 'path';
import type { CASOutput, CASEntryPoint, CASExitPoint, CASNode } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildCrossRepositoryLinks, buildCrossRepoJourneys, buildCrossRepoRouteDrift, pathsCompatible } from './product';
import { getAgentWorkPacket, type AgentTask } from './agent-adoption';

type GateStatus = 'pass' | 'warn' | 'fail';

export interface AnalysisTruthExpectation {
  name?: string;
  frameworks?: string[];
  languages?: string[];
  libraries?: string[];
  routes?: Array<{ method?: string; path: string; handler?: string; controller?: string }>;
  nodes?: Array<{ name: string; type?: string; file?: string }>;
  data_entities?: string[];
  relationships?: Array<{ source: string; target: string; type?: string }>;
  method_calls?: Array<{ caller: string; target?: string; method?: string; resolution_type?: string }>;
  exit_points?: Array<{ type?: string; name?: string; target?: string }>;
  runtime_signals?: string[];
  minimums?: Partial<Record<'nodes' | 'edges' | 'entry_points' | 'exit_points' | 'method_calls' | 'runtime_static_links' | 'analysis_facts', number>>;
}

interface MasteryCheck {
  id: string;
  status: GateStatus;
  score: number;
  expected: unknown;
  actual?: unknown;
  detail: string;
}

export async function loadTruthExpectation(projectPath: string): Promise<AnalysisTruthExpectation | null> {
  const candidates = [
    path.join(projectPath, '.klauro', 'analysis-expectations.json'),
    path.join(projectPath, 'klauro.analysis.json'),
    path.join(projectPath, 'analysis-expectations.json'),
  ];

  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) return fs.readJson(candidate);
  }

  return null;
}

export function evaluateAnalysisTruth(cas: CASOutput, expectation: AnalysisTruthExpectation) {
  const checks: MasteryCheck[] = [
    ...checkNames('framework', expectation.frameworks || [], detectedFrameworks(cas)),
    ...checkNames('language', expectation.languages || [], detectedLanguages(cas)),
    ...checkNames('library', expectation.libraries || [], detectedLibraries(cas)),
    ...checkRoutes(cas, expectation.routes || []),
    ...checkNodes(cas, expectation.nodes || []),
    ...checkNames('data-entity', expectation.data_entities || [], dataEntityNames(cas)),
    ...checkRelationships(cas, expectation.relationships || []),
    ...checkMethodCalls(cas, expectation.method_calls || []),
    ...checkExitPoints(cas, expectation.exit_points || []),
    ...checkNames('runtime-signal', expectation.runtime_signals || [], (cas.runtime_static_links || []).map(link => link.runtime_signal)),
    ...checkMinimums(cas, expectation.minimums || {}),
  ];
  const score = checks.length === 0
    ? 100
    : Math.round(checks.reduce((sum, check) => sum + check.score, 0) / checks.length);
  const status = checks.some(check => check.status === 'fail')
    ? 'fail'
    : checks.some(check => check.status === 'warn') ? 'warn' : 'pass';

  return {
    expectation: expectation.name || 'analysis-truth',
    generated_at: new Date().toISOString(),
    status,
    score,
    total_checks: checks.length,
    checks,
    misses: checks.filter(check => check.status !== 'pass'),
  };
}

export function getSemanticMap(cas: CASOutput, opts: { target?: string; limit?: number } = {}) {
  const limit = opts.limit || 50;
  const target = opts.target?.toLowerCase();
  const nodes = target
    ? cas.nodes.filter(node => [
        node.name,
        node.qualified_name,
        node.source?.file,
        node.description,
      ].filter(Boolean).some(value => String(value).toLowerCase().includes(target)))
    : cas.nodes;
  const selectedNodes = nodes.slice(0, limit);
  const selectedIds = new Set(selectedNodes.map(node => node.id));
  const files = new Map<string, {
    file: string;
    nodes: Array<Record<string, unknown>>;
    imports: Array<Record<string, unknown>>;
    exports: Array<Record<string, unknown>>;
    data_entities: string[];
    entry_points: string[];
    exit_points: string[];
  }>();

  const ensureFile = (file?: string) => {
    const key = file || '<unknown>';
    if (!files.has(key)) {
      files.set(key, {
        file: key,
        nodes: [],
        imports: [],
        exports: [],
        data_entities: [],
        entry_points: [],
        exit_points: [],
      });
    }
    return files.get(key)!;
  };

  for (const node of selectedNodes) {
    const file = ensureFile(normalizeFile(cas, node.source?.file));
    file.nodes.push(nodeSummary(node));
    if (node.type === 'import') {
      const nodeMetadata = node.metadata as Record<string, any> | undefined;
      file.imports.push({
        id: node.id,
        source: nodeMetadata?.source || nodeMetadata?.attributes?.source,
        specifiers: nodeMetadata?.specifiers || nodeMetadata?.attributes?.specifiers || [],
        line: node.source?.line,
      });
    }
    if (node.metadata?.is_exported) {
      file.exports.push(nodeSummary(node));
    }
  }

  for (const entity of cas.data_entities || []) {
    for (const nodeId of [
      ...(entity.lifecycle?.created_by || []),
      ...(entity.lifecycle?.read_by || []),
      ...(entity.lifecycle?.updated_by || []),
      ...(entity.lifecycle?.deleted_by || []),
    ]) {
      const node = cas.nodes.find(candidate => candidate.id === nodeId);
      if (node?.source?.file && (!target || selectedIds.has(node.id))) {
        const file = ensureFile(normalizeFile(cas, node.source.file));
        if (!file.data_entities.includes(entity.name)) file.data_entities.push(entity.name);
      }
    }
  }

  for (const entry of cas.entry_points || []) {
    const node = cas.nodes.find(candidate => candidate.id === entry.source_node || candidate.id === entry.handler?.node_id);
    if (node?.source?.file && (!target || selectedIds.has(node.id))) {
      ensureFile(normalizeFile(cas, node.source.file)).entry_points.push(entry.id);
    }
  }

  for (const exitPoint of cas.exit_points || []) {
    const node = cas.nodes.find(candidate => candidate.id === exitPoint.source_node);
    if (node?.source?.file && (!target || selectedIds.has(node.id))) {
      ensureFile(normalizeFile(cas, node.source.file)).exit_points.push(exitPoint.id);
    }
  }

  return {
    generated_at: new Date().toISOString(),
    target: opts.target || null,
    total_matching_nodes: nodes.length,
    files: [...files.values()],
    relationships: cas.edges
      .filter(edge => selectedIds.has(edge.source) || selectedIds.has(edge.target))
      .slice(0, limit * 3)
      .map(edge => ({
        id: edge.id,
        source: nodeLabel(cas, edge.source),
        target: nodeLabel(cas, edge.target),
        type: edge.type,
        category: edge.category,
        confidence: edge.metadata?.confidence,
      })),
    method_calls: (cas.method_calls || [])
      .filter(call => selectedIds.has(call.caller_node) || Boolean(call.target_node && selectedIds.has(call.target_node)))
      .slice(0, limit * 2)
      .map(call => ({
        id: call.id,
        caller: nodeLabel(cas, call.caller_node),
        target: call.target_node ? nodeLabel(cas, call.target_node) : call.call_details.method_name,
        method: call.call_details.method_name,
        file: normalizeFile(cas, call.call_details.location.file),
        line: call.call_details.location.line,
        resolution_type: call.call_details.resolution_type,
        external: call.external_details || null,
      })),
  };
}

export function getFrameworkDepthReport(cas: CASOutput) {
  const frameworks = detectedFrameworks(cas);
  const analyzers = (cas.analyzer_contributions || []).map(contribution => contribution.analyzer_name);
  const rows = frameworks.map(framework => {
    const lower = framework.toLowerCase();
    const relatedNodes = cas.nodes.filter(node =>
      namesCompatible(String(node.metadata?.framework || ''), framework) ||
      node.tags?.some(tag => namesCompatible(tag.replace(/^analyzer:/i, ''), framework)) ||
      node.subcategories?.some(category => namesCompatible(category, framework)) ||
      namesCompatible(node.type, framework) ||
      frameworkNodeMatch(node, lower)
    );
    const relatedEntries = (cas.entry_points || []).filter(entry =>
      namesCompatible(String(entry.metadata?.framework || ''), framework) ||
      relatedNodes.some(node => node.id === entry.source_node || node.id === entry.handler?.node_id)
    );
    const relatedExits = (cas.exit_points || []).filter(exitPoint =>
      relatedNodes.some(node => node.id === exitPoint.source_node)
    );
    const scoreParts = [
      analyzers.some(analyzer => namesCompatible(analyzer.replace(/\s+Analyzer$/i, '').replace(/\s+ORM$/i, ''), framework)) ? 100 : 70,
      relatedNodes.length > 0 ? 100 : 40,
      frameworkRequiresEntryPoint(lower) ? (relatedEntries.length > 0 ? 100 : 65) : 100,
      cas.analysis_facts?.length ? 100 : 75,
      cas.runtime_static_links?.length ? 100 : 75,
    ];
    const score = Math.round(scoreParts.reduce((sum, value) => sum + value, 0) / scoreParts.length);
    const gaps = [];
    if (relatedNodes.length === 0) gaps.push('No framework-tagged nodes');
    if (relatedEntries.length === 0 && frameworkRequiresEntryPoint(lower)) gaps.push('No framework entry points');
    if (!cas.analysis_facts?.length) gaps.push('No evidence facts');
    if (!cas.runtime_static_links?.length) gaps.push('No runtime links');

    return {
      framework,
      status: score >= 90 ? 'pass' : score >= 75 ? 'warn' : 'fail',
      score,
      analyzer_present: scoreParts[0] === 100,
      nodes: relatedNodes.length,
      entry_points: relatedEntries.length,
      exit_points: relatedExits.length,
      gaps,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    status: rows.some(row => row.status === 'fail') ? 'fail' : rows.some(row => row.status === 'warn') ? 'warn' : 'pass',
    frameworks: rows,
    uncovered_expectations: expectedFrameworkSurfaces(frameworks, cas),
  };
}

export function getCrossRepoContracts(
  repositories: Array<{ path: string; name: string; cas: CASOutput }>,
  options: { journey_limit?: number } = {}
) {
  const repoContracts = repositories.map(repository => ({
    path: repository.path,
    name: repository.name,
    provides: {
      http: (repository.cas.entry_points || [])
        .filter(entry => entry.type === 'http' || entry.type === 'route')
        .map(entry => httpContract(entry)),
      messages: (repository.cas.entry_points || [])
        .filter(entry => entry.type === 'message' || entry.type === 'event')
        .map(entry => messageEntryContract(entry)),
      databases: dataEntityNames(repository.cas),
    },
    consumes: {
      http: (repository.cas.exit_points || [])
        .filter(exitPoint => exitPoint.type === 'api' || exitPoint.type === 'webhook')
        .map(exitPoint => apiExitContract(exitPoint)),
      messages: (repository.cas.exit_points || [])
        .filter(exitPoint => exitPoint.type === 'message' || exitPoint.type === 'event')
        .map(exitPoint => messageExitContract(exitPoint)),
      databases: (repository.cas.exit_points || [])
        .filter(exitPoint => exitPoint.type === 'database')
        .map(exitPoint => exitPoint.target?.resource || exitPoint.name),
    },
  }));
  const links = buildCrossRepositoryLinks(repositories);
  const journeys = buildCrossRepoJourneys(repositories, links.links, { limit: options.journey_limit });
  const routeDrift = buildCrossRepoRouteDrift(repositories);

  return {
    generated_at: new Date().toISOString(),
    repository_count: repositories.length,
    repositories: repoContracts,
    links,
    contract_table: buildContractTable(repositories, links.links),
    journeys,
    route_drift_summary: {
      total: routeDrift.length,
      missing_route: routeDrift.filter(finding => finding.kind === 'missing-route').length,
      near_miss: routeDrift.filter(finding => finding.kind === 'near-miss').length,
    },
    route_drift: routeDrift.slice(0, 10),
    contract_gaps: findContractGaps(repoContracts, links.links.length),
  };
}

function buildContractTable(
  repositories: Array<{ path: string; name: string; cas: CASOutput }>,
  links: Array<NonNullable<CASOutput['cross_repository_links']>[number]>
) {
  const byPath = new Map(repositories.map(repository => [repository.path, repository]));

  return links
    .filter(link => link.type === 'api' && link.source_repository?.path && link.target_repository?.path)
    .map(link => {
      const consumer = byPath.get(link.source_repository!.path!);
      const provider = byPath.get(link.target_repository!.path!);
      const consumerNode = consumer?.cas.nodes.find(node => (link.source_repository?.node_ids || []).includes(node.id));
      const providerEntry = (provider?.cas.entry_points || []).find(entry =>
        (link.target_repository?.node_ids || []).includes(entry.source_node)
      );
      const handlerOwner = provider?.cas.nodes.find(node =>
        (node.type === 'controller' || node.type === 'class') &&
        node.source?.file &&
        providerEntry?.handler?.file &&
        pathsCompatible(node.source.file, providerEntry.handler.file)
      );

      return {
        method: link.connection?.method || providerEntry?.trigger?.method,
        route: providerEntry?.trigger?.path || link.connection?.endpoint,
        consumer_repository: consumer?.name || link.source_repository?.path,
        consumer_file: consumerNode?.source?.file,
        consumer_symbol: consumerNode?.name,
        provider_repository: provider?.name || link.target_repository?.path,
        provider_handler: providerEntry?.handler?.method_name
          ? `${handlerOwner?.name || ''}${handlerOwner ? '::' : ''}${providerEntry.handler.method_name}`
          : undefined,
        provider_file: providerEntry?.handler?.file,
        provider_line: providerEntry?.handler?.line,
        confidence: link.metadata?.confidence,
      };
    })
    .sort((left, right) => {
      const routeOrder = String(left.route || '').localeCompare(String(right.route || ''));
      if (routeOrder !== 0) return routeOrder;
      return String(left.method || '').localeCompare(String(right.method || ''));
    })
    .slice(0, 500);
}

export function getRuntimeInstrumentationPlan(cas: CASOutput, opts: { limit?: number } = {}) {
  const limit = opts.limit || 50;
  const links = cas.runtime_static_links || [];
  const byStatus = links.reduce<Record<string, number>>((counts, link) => {
    counts[link.telemetry_status] = (counts[link.telemetry_status] || 0) + 1;
    return counts;
  }, {});

  return {
    generated_at: new Date().toISOString(),
    status: links.length > 0 ? 'ready' : 'needs-instrumentation',
    totals: {
      runtime_static_links: links.length,
      by_status: byStatus,
    },
    event_contract: {
      required: ['type', 'timestamp'],
      recommended: ['static_id', 'node_id', 'entry_point_id', 'exit_point_id', 'call_chain_id', 'signal', 'route', 'method', 'status_code', 'duration_ms', 'error_message', 'stack'],
    },
    instrumentation_points: links.slice(0, limit).map(link => ({
      runtime_signal: link.runtime_signal,
      telemetry_status: link.telemetry_status,
      confidence: link.confidence,
      kind: link.kind,
      static_id: link.static_id,
      static_label: staticLabel(cas, link.static_id),
      instrumentation_points: link.instrumentation_points,
      suggested_event: suggestedRuntimeEvent(cas, link),
    })),
    gaps: [
      ...(links.length === 0 ? ['No runtime_static_links available'] : []),
      ...links.filter(link => link.telemetry_status === 'not-instrumented').slice(0, 10).map(link => `${link.runtime_signal}: not instrumented`),
    ],
  };
}

export async function evaluateAgentTaskProof(cas: CASOutput, pathValue: string, tasks: AgentTask[]) {
  const taskReports = await Promise.all(tasks.map(async task => {
    const packet = await getAgentWorkPacket(cas, pathValue, task);
    const checks: MasteryCheck[] = [
      simpleCheck('target-resolved', Boolean(packet.selected_node), packet.selected_node?.id || 'no selected node'),
      simpleCheck('file-read-plan', packet.file_read_plan.length > 0, `${packet.file_read_plan.length} files`),
      simpleCheck('coding-context', Boolean(packet.work_context.coding_context && !('error' in (packet.work_context.coding_context as Record<string, unknown>))), 'coding context'),
      simpleCheck('risk-context', Boolean(packet.work_context.risk || packet.work_context.risk_context), 'risk context'),
      simpleCheck('test-context', Boolean(packet.work_context.tests), 'test context'),
      simpleCheck('mcp-followups', packet.next_mcp_calls.length > 0, `${packet.next_mcp_calls.length} calls`),
    ];
    const score = Math.round(checks.reduce((sum, check) => sum + check.score, 0) / checks.length);
    return {
      task,
      status: score >= 90 ? 'pass' : score >= 75 ? 'warn' : 'fail',
      score,
      checks,
      selected_node: packet.selected_node,
      file_read_plan: packet.file_read_plan,
      gaps: packet.gaps,
    };
  }));
  const score = taskReports.length
    ? Math.round(taskReports.reduce((sum, report) => sum + report.score, 0) / taskReports.length)
    : 100;

  return {
    generated_at: new Date().toISOString(),
    status: taskReports.some(report => report.status === 'fail') ? 'fail' : taskReports.some(report => report.status === 'warn') ? 'warn' : 'pass',
    score,
    tasks: taskReports,
  };
}

function checkNames(kind: string, expected: string[], actual: string[]): MasteryCheck[] {
  return expected.map(value => {
    const found = actual.find(candidate => namesCompatible(candidate, value));
    return {
      id: `${kind}:${value}`,
      status: found ? 'pass' : 'fail',
      score: found ? 100 : 0,
      expected: value,
      actual: found || null,
      detail: found ? `Found ${found}` : `Missing ${value}`,
    };
  });
}

function checkRoutes(cas: CASOutput, expected: NonNullable<AnalysisTruthExpectation['routes']>): MasteryCheck[] {
  const entries = [...(cas.entry_points || []), ...(cas.route_table || []).map(route => ({
    id: `route-table:${route.method}:${route.path}`,
    type: 'http',
    name: `${route.method} ${route.path}`,
    source_node: '',
    trigger: { method: route.method, path: route.path },
    handler: { node_id: route.source_node || '', method_name: route.handler || '' },
    metadata: { controller: route.controller },
  } as CASEntryPoint))];

  return expected.map(route => {
    const found = entries.find(entry => {
      const methodMatches = !route.method || !entry.trigger?.method || entry.trigger.method.toLowerCase() === route.method!.toLowerCase();
      const pathMatches = routesCompatible(entry.trigger?.path || entry.name, route.path);
      const handlerMatches = !route.handler || entry.handler?.method_name?.toLowerCase().includes(route.handler.toLowerCase());
      const controllerMatches = !route.controller || String(entry.metadata?.controller || entry.name).toLowerCase().includes(route.controller.toLowerCase());
      return methodMatches && pathMatches && handlerMatches && controllerMatches;
    });
    return {
      id: `route:${route.method || '*'}:${route.path}`,
      status: found ? 'pass' : 'fail',
      score: found ? 100 : 0,
      expected: route,
      actual: found ? { id: found.id, method: found.trigger?.method, path: found.trigger?.path, handler: found.handler } : null,
      detail: found ? `Found ${found.name}` : `Missing ${route.method || '*'} ${route.path}`,
    };
  });
}

function checkNodes(cas: CASOutput, expected: NonNullable<AnalysisTruthExpectation['nodes']>): MasteryCheck[] {
  return expected.map(nodeExpectation => {
    const found = cas.nodes.find(node =>
      namesCompatible(node.name, nodeExpectation.name) &&
      (!nodeExpectation.type || node.type === nodeExpectation.type) &&
      (!nodeExpectation.file || normalizeFile(cas, node.source?.file).endsWith(nodeExpectation.file))
    );
    return {
      id: `node:${nodeExpectation.name}`,
      status: found ? 'pass' : 'fail',
      score: found ? 100 : 0,
      expected: nodeExpectation,
      actual: found ? nodeSummary(found) : null,
      detail: found ? `Found ${found.name}` : `Missing ${nodeExpectation.name}`,
    };
  });
}

function checkRelationships(cas: CASOutput, expected: NonNullable<AnalysisTruthExpectation['relationships']>): MasteryCheck[] {
  return expected.map(relationship => {
    const sourceNodes = cas.nodes.filter(node => namesCompatible(node.name, relationship.source) || node.id === relationship.source);
    const targetNodes = cas.nodes.filter(node => namesCompatible(node.name, relationship.target) || node.id === relationship.target);
    const found = cas.edges.find(edge =>
      sourceNodes.some(node => node.id === edge.source) &&
      targetNodes.some(node => node.id === edge.target) &&
      (!relationship.type || edge.type === relationship.type)
    );
    return {
      id: `relationship:${relationship.source}->${relationship.target}`,
      status: found ? 'pass' : 'fail',
      score: found ? 100 : 0,
      expected: relationship,
      actual: found ? { id: found.id, type: found.type } : null,
      detail: found ? `Found ${found.type}` : `Missing ${relationship.source} -> ${relationship.target}`,
    };
  });
}

function checkMethodCalls(cas: CASOutput, expected: NonNullable<AnalysisTruthExpectation['method_calls']>): MasteryCheck[] {
  return expected.map(callExpectation => {
    const found = (cas.method_calls || []).find(call => {
      const caller = cas.nodes.find(node => node.id === call.caller_node);
      const target = call.target_node ? cas.nodes.find(node => node.id === call.target_node) : undefined;
      const callerMatches = caller && (namesCompatible(caller.name, callExpectation.caller) || caller.id === callExpectation.caller);
      const targetMatches = !callExpectation.target ||
        (target && (namesCompatible(target.name, callExpectation.target) || target.id === callExpectation.target)) ||
        namesCompatible(call.call_details.method_name, callExpectation.target);
      const methodMatches = !callExpectation.method || namesCompatible(call.call_details.method_name, callExpectation.method);
      const resolutionMatches = !callExpectation.resolution_type || call.call_details.resolution_type === callExpectation.resolution_type;
      return callerMatches && targetMatches && methodMatches && resolutionMatches;
    });
    return {
      id: `method-call:${callExpectation.caller}->${callExpectation.target || callExpectation.method || '*'}`,
      status: found ? 'pass' : 'fail',
      score: found ? 100 : 0,
      expected: callExpectation,
      actual: found ? {
        id: found.id,
        method: found.call_details.method_name,
        resolution_type: found.call_details.resolution_type,
      } : null,
      detail: found ? `Found ${found.call_details.method_name}` : `Missing method call ${callExpectation.caller} -> ${callExpectation.target || callExpectation.method || '*'}`,
    };
  });
}

function checkExitPoints(cas: CASOutput, expected: NonNullable<AnalysisTruthExpectation['exit_points']>): MasteryCheck[] {
  return expected.map(exitExpectation => {
    const found = (cas.exit_points || []).find(exitPoint => {
      const typeMatches = !exitExpectation.type || exitPoint.type === exitExpectation.type;
      const nameMatches = !exitExpectation.name || namesCompatible(exitPoint.name, exitExpectation.name);
      const targetValues = [
        exitPoint.target?.endpoint,
        exitPoint.target?.resource,
        exitPoint.target?.service_id,
        exitPoint.target?.sdk,
        exitPoint.name,
      ].filter(Boolean) as string[];
      const targetMatches = !exitExpectation.target || targetValues.some(value => targetCompatible(value, exitExpectation.target!));
      return typeMatches && nameMatches && targetMatches;
    });
    return {
      id: `exit-point:${exitExpectation.type || '*'}:${exitExpectation.name || exitExpectation.target || '*'}`,
      status: found ? 'pass' : 'fail',
      score: found ? 100 : 0,
      expected: exitExpectation,
      actual: found ? { id: found.id, name: found.name, type: found.type, target: found.target } : null,
      detail: found ? `Found ${found.name}` : `Missing exit point ${exitExpectation.name || exitExpectation.target || exitExpectation.type || '*'}`,
    };
  });
}

function checkMinimums(cas: CASOutput, minimums: NonNullable<AnalysisTruthExpectation['minimums']>): MasteryCheck[] {
  const actuals: Record<string, number> = {
    nodes: cas.nodes.length,
    edges: cas.edges.length,
    entry_points: cas.entry_points?.length || 0,
    exit_points: cas.exit_points?.length || 0,
    method_calls: cas.method_calls?.length || 0,
    runtime_static_links: cas.runtime_static_links?.length || 0,
    analysis_facts: cas.analysis_facts?.length || 0,
  };

  return Object.entries(minimums).map(([key, minimum]) => {
    const actual = actuals[key as keyof typeof actuals] || 0;
    const passed = actual >= (minimum || 0);
    return {
      id: `minimum:${key}`,
      status: passed ? 'pass' : 'fail',
      score: passed ? 100 : ratioScore(actual, minimum || 1),
      expected: minimum,
      actual,
      detail: passed ? `${actual}/${minimum}` : `Expected at least ${minimum}, found ${actual}`,
    };
  });
}

function simpleCheck(id: string, passed: boolean, detail: string): MasteryCheck {
  return {
    id,
    status: passed ? 'pass' : 'fail',
    score: passed ? 100 : 0,
    expected: true,
    actual: passed,
    detail,
  };
}

function ratioScore(actual: number, expected: number): number {
  if (expected <= 0) return 100;
  return Math.round(Math.min(100, (actual / expected) * 100));
}

function detectedFrameworks(cas: CASOutput): string[] {
  const names = new Set<string>();
  for (const framework of cas.system.technologies?.frameworks || []) {
    if (framework.name) names.add(framework.name);
  }
  for (const contribution of cas.analyzer_contributions || []) {
    const name = contribution.analyzer_name
      .replace(/\s+Analyzer$/i, '')
      .replace(/\s+ORM$/i, '')
      .trim();
    if (['Prisma', 'Socket.io', 'React Router', 'Redux/RTK', 'Zustand', 'TanStack Query'].some(value => namesCompatible(name, value))) {
      names.add(name);
    }
  }
  return [...names];
}

function detectedLanguages(cas: CASOutput): string[] {
  return cas.system.technologies?.languages?.map(language => language.name).filter(Boolean) || [];
}

function detectedLibraries(cas: CASOutput): string[] {
  const names = new Set<string>();
  for (const library of cas.libraries || []) {
    if (library.name) names.add(library.name);
    if (library.category) names.add(library.category);
  }
  for (const contribution of cas.analyzer_contributions || []) {
    if (contribution.contribution_type !== 'library') continue;
    const name = contribution.analyzer_name
      .replace(/\s+Analyzer$/i, '')
      .replace(/\s+ORM$/i, '')
      .trim();
    if (name) names.add(name);
  }
  return [...names];
}

function dataEntityNames(cas: CASOutput): string[] {
  return [
    ...(cas.data_entities || []).map(entity => entity.name),
    ...(cas.database_schema?.entities || []).map(entity => entity.name),
    ...cas.nodes.filter(node => node.type === 'entity' || node.type === 'model').map(node => node.name),
  ];
}

function namesCompatible(actual: string, expected: string): boolean {
  const left = normalizeName(actual);
  const right = normalizeName(expected);
  return left === right || left.includes(right) || right.includes(left);
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeRoute(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .replace(/:[a-z0-9_]+/g, ':param')
    .replace(/\{[a-z0-9_]+\}/g, ':param');
}

function routesCompatible(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = normalizeRoute(actual);
  const right = normalizeRoute(expected);
  return left === right || left.endsWith(right) || right.endsWith(left);
}

function targetCompatible(actual: string, expected: string): boolean {
  if (namesCompatible(actual, expected)) return true;
  return normalizeDynamicTarget(actual) === normalizeDynamicTarget(expected);
}

function normalizeDynamicTarget(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/[?#].*$/, '')
    .replace(/\$\{[^}]+\}/g, ':param')
    .replace(/\{[^}]+\}/g, ':param')
    .replace(/\[[^\]]+\]/g, ':param')
    .replace(/:[a-z0-9_.]+/g, ':param')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function nodeSummary(node: CASNode) {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    qualified_name: node.qualified_name,
    file: node.source?.file,
    line: node.source?.line,
    exported: node.metadata?.is_exported || false,
  };
}

function nodeLabel(cas: CASOutput, nodeId: string) {
  const node = cas.nodes.find(candidate => candidate.id === nodeId);
  return node ? { id: node.id, name: node.name, type: node.type, file: normalizeFile(cas, node.source?.file), line: node.source?.line } : { id: nodeId };
}

function normalizeFile(cas: CASOutput, file?: string): string {
  if (!file) return '';
  const normalizedFile = file.replace(/\\/g, '/');
  const root = cas.system.root_path?.replace(/\\/g, '/').replace(/\/$/, '');
  if (root && normalizedFile.startsWith(`${root}/`)) return normalizedFile.slice(root.length + 1);
  return normalizedFile.replace(/^\.\//, '');
}

function expectedFrameworkSurfaces(frameworks: string[], cas: CASOutput): string[] {
  const gaps: string[] = [];
  const lower = frameworks.map(framework => framework.toLowerCase());
  if (lower.some(framework => framework.includes('nest')) && !(cas.entry_points || []).some(entry => ['http', 'route', 'message', 'event', 'websocket'].includes(entry.type))) {
    gaps.push('NestJS detected but no entry points found');
  }
  if (lower.some(framework => framework.includes('react')) && !cas.nodes.some(node => node.type.includes('component') || node.type.includes('page') || frameworkNodeMatch(node, 'react'))) {
    gaps.push('React detected but no component/page nodes found');
  }
  if (lower.some(framework => framework.includes('django') || framework.includes('flask') || framework.includes('fastapi')) && !(cas.entry_points || []).length) {
    gaps.push('Python web framework detected but no entry points found');
  }
  return gaps;
}

function frameworkNodeMatch(node: CASNode, framework: string): boolean {
  const file = node.source?.file?.toLowerCase() || '';
  const metadata = node.metadata as Record<string, any> | undefined;
  const subcategories = node.subcategories || [];
  const tags = node.tags || [];
  if ((framework.includes('express') || framework.includes('next') || framework.includes('nest')) && subcategories.some(category => namesCompatible(category, framework))) return true;
  if (framework.includes('express') && (metadata?.framework === 'express' || subcategories.includes('express') || file.endsWith('server.ts'))) return true;
  if (framework.includes('next')) return file.includes('/app/') || file.endsWith('next.config.js') || metadata?.framework === 'nextjs';
  if (framework.includes('nest')) return subcategories.some(category => category.includes('nestjs')) || tags.some(tag => tag.includes('nestjs')) || file.includes('.controller.') || file.includes('.events.');
  if (framework.includes('react')) {
    return file.endsWith('.tsx') && /^[A-Z]/.test(node.name) && ['function', 'class', 'method', 'arrow'].includes(node.type);
  }
  if (framework.includes('prisma')) {
    const metadata = node.metadata as Record<string, any> | undefined;
    return node.type === 'entity' || metadata?.orm === 'Prisma' || metadata?.source === 'prisma_schema';
  }
  return false;
}

function frameworkRequiresEntryPoint(framework: string): boolean {
  if (framework.includes('react') || framework.includes('prisma')) return false;
  if (framework === 'c#' || framework.includes('csharp')) return false;
  return true;
}

function httpContract(entry: CASEntryPoint) {
  return {
    id: entry.id,
    method: entry.trigger?.method,
    path: entry.trigger?.path,
    handler: entry.handler,
    input: entry.input,
    output: entry.output,
    security: entry.security,
  };
}

function messageEntryContract(entry: CASEntryPoint) {
  return {
    id: entry.id,
    event: entry.trigger?.event || entry.name,
    input: entry.input,
    handler: entry.handler,
  };
}

function apiExitContract(exitPoint: CASExitPoint) {
  return {
    id: exitPoint.id,
    endpoint: exitPoint.target?.endpoint || exitPoint.target?.resource || exitPoint.name,
    method: exitPoint.operation?.method,
    source_node: exitPoint.source_node,
    data: exitPoint.data,
  };
}

function messageExitContract(exitPoint: CASExitPoint) {
  return {
    id: exitPoint.id,
    topic: exitPoint.target?.resource || exitPoint.name,
    source_node: exitPoint.source_node,
    data: exitPoint.data,
  };
}

function findContractGaps(repoContracts: Array<Record<string, any>>, linkCount: number): string[] {
  const gaps: string[] = [];
  if (repoContracts.length > 1 && linkCount === 0) gaps.push('No deterministic cross-repo links found');
  for (const repo of repoContracts) {
    const provides = repo.provides;
    const consumes = repo.consumes;
    if (provides.http.length === 0 && provides.messages.length === 0 && provides.databases.length === 0) {
      gaps.push(`${repo.name}: no provided contracts detected`);
    }
    if (consumes.http.length === 0 && consumes.messages.length === 0 && consumes.databases.length === 0) {
      gaps.push(`${repo.name}: no consumed contracts detected`);
    }
  }
  return gaps.slice(0, 20);
}

function staticLabel(cas: CASOutput, staticId: string) {
  const node = cas.nodes.find(candidate => candidate.id === staticId);
  if (node) return nodeSummary(node);
  const entry = (cas.entry_points || []).find(candidate => candidate.id === staticId);
  if (entry) return { id: entry.id, name: entry.name, type: `entry:${entry.type}` };
  const exitPoint = (cas.exit_points || []).find(candidate => candidate.id === staticId);
  if (exitPoint) return { id: exitPoint.id, name: exitPoint.name, type: `exit:${exitPoint.type}` };
  const chain = (cas.call_chains || []).find(candidate => candidate.id === staticId);
  if (chain) return { id: chain.id, name: chain.chain_type, type: 'call-chain' };
  return { id: staticId };
}

function suggestedRuntimeEvent(cas: CASOutput, link: NonNullable<CASOutput['runtime_static_links']>[number]) {
  const base: Record<string, unknown> = {
    type: link.kind === 'exit-point' ? 'exit' : 'request',
    static_id: link.static_id,
    signal: link.runtime_signal,
  };
  const entry = (cas.entry_points || []).find(candidate => candidate.id === link.static_id);
  if (entry) {
    base.entry_point_id = entry.id;
    base.method = entry.trigger?.method;
    base.route = entry.trigger?.path;
  }
  const exitPoint = (cas.exit_points || []).find(candidate => candidate.id === link.static_id);
  if (exitPoint) {
    base.exit_point_id = exitPoint.id;
    base.path = exitPoint.target?.endpoint || exitPoint.target?.resource;
  }
  return base;
}
