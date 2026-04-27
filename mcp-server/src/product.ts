import type {
  CASCallChain,
  CASCrossRepositoryLink,
  CASEntryPoint,
  CASExitPoint,
  CASNode,
  CASOutput,
  CASRuntimeStaticLink,
} from '../../backend/src/types/cas.types';
import {
  assessChangeRisk,
  buildSummary,
  findTests,
  getCallChain,
  getCallers,
  getCallees,
  getCodingContext,
  getDataEntities,
  getEntryPoints,
  getExitPoints,
  getExternalServices,
  getFlowCoverage,
  getRuntimeStaticLinks,
  getSecurityOverview,
  getSystemOverview,
  searchNodes,
} from './query';

export interface EvidenceRef {
  type: 'node' | 'edge' | 'entry_point' | 'exit_point' | 'call_chain' | 'runtime_link' | 'repository_link' | 'fact' | 'data_entity' | 'test' | 'summary';
  id: string;
  label: string;
  file?: string;
  line?: number;
  confidence?: number;
}

export interface AnswerPackQuestion {
  id: string;
  question: string;
  required_tools: string[];
}

export interface AnswerPackResult {
  pack: string;
  path: string;
  generated_at: string;
  answers: Array<{
    id: string;
    question: string;
    answer: Record<string, unknown>;
    evidence: EvidenceRef[];
    confidence: number;
    follow_up_tools: string[];
  }>;
  gaps: string[];
}

export interface RuntimeEventInput {
  type: 'request' | 'error' | 'exit' | 'log' | 'custom';
  timestamp?: string;
  signal?: string;
  static_id?: string;
  node_id?: string;
  entry_point_id?: string;
  exit_point_id?: string;
  call_chain_id?: string;
  method?: string;
  route?: string;
  path?: string;
  status_code?: number;
  duration_ms?: number;
  error_message?: string;
  stack?: string;
  attributes?: Record<string, unknown>;
}

export interface RuntimeObservation {
  id: string;
  project_path: string;
  recorded_at: string;
  event: RuntimeEventInput & { timestamp: string };
  correlation: RuntimeCorrelationResult;
}

export interface RuntimeCorrelationResult {
  status: 'matched' | 'partial' | 'unmatched';
  best_match?: EvidenceRef;
  matches: EvidenceRef[];
  runtime_links: CASRuntimeStaticLink[];
  suggested_instrumentation: string[];
}

export function getAnswerPackCatalog(): Array<{
  id: string;
  name: string;
  description: string;
  questions: AnswerPackQuestion[];
}> {
  return [
    {
      id: 'mastery',
      name: 'Codebase Mastery',
      description: 'Core questions that prove an agent can understand and safely work in a codebase from CAS.',
      questions: answerQuestions(),
    },
  ];
}

export function runAnswerPack(cas: CASOutput, path: string, pack = 'mastery'): AnswerPackResult {
  if (pack !== 'mastery') {
    return {
      pack,
      path,
      generated_at: new Date().toISOString(),
      answers: [],
      gaps: [`Unknown answer pack: ${pack}`],
    };
  }

  const gaps: string[] = [];
  const answers = [
    answerOverview(cas),
    answerEntryPoints(cas),
    answerRepresentativeFlow(cas),
    answerImpact(cas),
    answerData(cas),
    answerTests(cas),
    answerExternalBoundaries(cas),
    answerSecurity(cas),
    answerRuntimeReadiness(cas),
  ];

  for (const answer of answers) {
    if (answer.confidence < 0.8) {
      gaps.push(`${answer.id}: low confidence (${answer.confidence})`);
    }
  }

  return {
    pack,
    path,
    generated_at: new Date().toISOString(),
    answers,
    gaps,
  };
}

function answerQuestions(): AnswerPackQuestion[] {
  return [
    { id: 'overview', question: 'What is this codebase and what technologies does it use?', required_tools: ['get_system_overview', 'get_summary'] },
    { id: 'entry-points', question: 'What are the main ways execution enters this system?', required_tools: ['get_entry_points', 'get_route_table'] },
    { id: 'representative-flow', question: 'What happens after a representative entry point is invoked?', required_tools: ['get_call_chain', 'get_node'] },
    { id: 'change-impact', question: 'What would be affected if a central code element changed?', required_tools: ['get_callers', 'get_callees', 'assess_change_risk', 'get_coding_context'] },
    { id: 'data', question: 'What data does this system read or write?', required_tools: ['get_data_entities', 'get_database_schema', 'get_exit_points'] },
    { id: 'tests', question: 'What tests and flow coverage exist?', required_tools: ['find_tests', 'get_flow_coverage', 'get_test_summary'] },
    { id: 'external-boundaries', question: 'What external systems, files, messages, APIs, or caches does this code touch?', required_tools: ['get_exit_points', 'get_external_services'] },
    { id: 'security', question: 'Where are security boundaries and auth-related code?', required_tools: ['get_security_overview', 'search_nodes'] },
    { id: 'runtime-readiness', question: 'What runtime signals can be correlated back to CAS?', required_tools: ['get_runtime_static_links'] },
  ];
}

function answerOverview(cas: CASOutput) {
  const summary = buildSummary(cas);
  const overview = getSystemOverview(cas);
  return answer('overview', {
    name: summary.name,
    type: summary.type,
    description: overview.enhanced_system_purpose?.inferred_description || overview.description,
    languages: summary.languages,
    frameworks: summary.frameworks,
    nodes: summary.nodes,
    edges: summary.edges,
    top_capabilities: summary.top_capabilities,
  }, [
    summaryEvidence('system-summary', 'System summary'),
    ...nodeEvidence(cas.nodes.slice(0, 5)),
  ], confidence(summary.nodes > 0, summary.edges > 0, summary.languages.length > 0));
}

function answerEntryPoints(cas: CASOutput) {
  const entryPoints = getEntryPoints(cas, { limit: 15 });
  return answer('entry-points', {
    total: entryPoints.total,
    examples: entryPoints.entry_points.map(entry => ({
      id: entry.id,
      name: entry.name,
      type: entry.type,
      trigger: entry.trigger,
      handler: entry.handler,
    })),
  }, entryPointEvidence(entryPoints.entry_points), confidence(entryPoints.total > 0));
}

function answerRepresentativeFlow(cas: CASOutput) {
  const entryPoint = (cas.entry_points || []).find(entry =>
    (cas.call_chains || []).some(chain => chain.entry_point.entry_point_id === entry.id)
  ) || (cas.entry_points || [])[0];

  if (!entryPoint) {
    return answer('representative-flow', { total: 0, message: 'CAS reports no entry points.' }, [summaryEvidence('flow-summary', 'No entry points reported')], 0.85);
  }

  const chainResult = getCallChain(cas, { entryPointId: entryPoint.id }) as { total: number; chains: CASCallChain[] };
  const chain = chainResult.chains[0];

  return answer('representative-flow', {
    entry_point: {
      id: entryPoint.id,
      name: entryPoint.name,
      type: entryPoint.type,
      trigger: entryPoint.trigger,
    },
    chain,
  }, [
    ...entryPointEvidence([entryPoint]),
    ...(chain ? callChainEvidence([chain]) : []),
    ...nodeEvidence(nodesForChain(cas, chain).slice(0, 8)),
  ], confidence(Boolean(chain), Boolean(entryPoint)));
}

function answerImpact(cas: CASOutput) {
  const target = findMostConnectedNode(cas);
  if (!target) {
    return answer('change-impact', { message: 'CAS reports no connected target node.' }, [summaryEvidence('impact-summary', 'No connected target node')], 0.8);
  }

  const callers = getCallers(cas, target.id, 2, 10);
  const callees = getCallees(cas, target.id, 2, 10);
  return answer('change-impact', {
    target: summarizeNode(target),
    callers,
    callees,
    risk: assessChangeRisk(cas, target.id),
    coding_context: getCodingContext(cas, target.id, { include: ['tests'] }),
  }, [
    ...nodeEvidence([target]),
    ...nodeEvidence(idsToNodes(cas, callers.callers.map(caller => caller.node_id))),
    ...nodeEvidence(idsToNodes(cas, callees.callees.map(callee => callee.node_id))),
  ], confidence(callers.total > 0 || callees.total > 0));
}

function answerData(cas: CASOutput) {
  const dataEntities = getDataEntities(cas, { limit: 15 });
  const databaseExits = getExitPoints(cas, { type: 'database', limit: 15 });
  const hasData = dataEntities.total > 0 || databaseExits.total > 0 || Boolean(cas.database_schema?.entities?.length);
  return answer('data', {
    data_entities: dataEntities,
    database_schema: cas.database_schema || null,
    database_exit_points: databaseExits,
  }, [
    summaryEvidence('data-summary', hasData ? 'CAS data surfaces found' : 'CAS reports no data surface'),
    ...dataEntities.entities.slice(0, 8).map(entity => ({ type: 'data_entity' as const, id: entity.id, label: entity.name })),
    ...exitPointEvidence(databaseExits.exit_points),
  ], hasData ? 0.95 : 0.85);
}

function answerTests(cas: CASOutput) {
  const tests = findTests(cas, { limit: 15 });
  const flowCoverage = getFlowCoverage(cas) as Record<string, unknown>;
  return answer('tests', {
    tests,
    flow_coverage: flowCoverage,
  }, [
    summaryEvidence('test-summary', tests.total_suites > 0 ? 'CAS test suites found' : 'CAS reports no test suites'),
    ...tests.suites.slice(0, 8).map(suite => ({ type: 'test' as const, id: suite.file_path, label: suite.name, file: suite.file_path })),
  ], tests.total_suites > 0 ? 0.95 : 0.85);
}

function answerExternalBoundaries(cas: CASOutput) {
  const exits = getExitPoints(cas, { limit: 20 });
  const externalServices = getExternalServices(cas);
  return answer('external-boundaries', {
    exit_points: exits,
    external_services: externalServices,
  }, [
    summaryEvidence('external-boundary-summary', exits.total > 0 ? 'CAS exit points found' : 'CAS reports no exit points'),
    ...exitPointEvidence(exits.exit_points),
  ], confidence(exits.total > 0 || externalServices.length > 0));
}

function answerSecurity(cas: CASOutput) {
  const security = getSecurityOverview(cas);
  const authNodes = searchNodes(cas, 'auth', { limit: 15 });
  const hasSecurity = security.boundary_count > 0 || security.context_count > 0 || authNodes.length > 0;
  return answer('security', {
    security,
    auth_nodes: authNodes,
  }, [
    summaryEvidence('security-summary', hasSecurity ? 'CAS security surfaces found' : 'CAS reports no security surface'),
    ...idsToNodes(cas, authNodes.map(node => node.id)).map(node => nodeRef(node)),
  ], hasSecurity ? 0.95 : 0.85);
}

function answerRuntimeReadiness(cas: CASOutput) {
  const runtimeLinks = getRuntimeStaticLinks(cas, { limit: 20 });
  const instrumentable = (cas.runtime_static_links || []).filter(link => link.telemetry_status === 'instrumentable');
  return answer('runtime-readiness', {
    runtime_static_links: runtimeLinks,
    runtime: cas.runtime || null,
    instrumentable_count: instrumentable.length,
  }, [
    summaryEvidence('runtime-summary', 'Runtime-to-CAS correlation readiness'),
    ...runtimeLinkEvidence((cas.runtime_static_links || []).slice(0, 10)),
  ], confidence((cas.runtime_static_links || []).length > 0));
}

function answer(id: string, answerValue: Record<string, unknown>, evidence: EvidenceRef[], confidenceValue: number) {
  const question = answerQuestions().find(candidate => candidate.id === id);
  return {
    id,
    question: question?.question || id,
    answer: answerValue,
    evidence,
    confidence: confidenceValue,
    follow_up_tools: question?.required_tools || [],
  };
}

export function buildCrossRepositoryLinks(repositories: Array<{ path: string; name: string; cas: CASOutput }>): {
  generated_at: string;
  repository_count: number;
  links: CASCrossRepositoryLink[];
  summary: Record<string, number>;
} {
  const links: CASCrossRepositoryLink[] = [];

  for (let leftIndex = 0; leftIndex < repositories.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < repositories.length; rightIndex++) {
      const left = repositories[leftIndex];
      const right = repositories[rightIndex];
      links.push(...detectApiLinks(left, right));
      links.push(...detectApiLinks(right, left));
      links.push(...detectSharedDatabaseLinks(left, right));
      links.push(...detectMessageLinks(left, right));
      links.push(...detectMessageLinks(right, left));
      links.push(...detectSharedLibraryLinks(left, right));
    }
  }

  const deduped = dedupeLinks(links);
  const summary = deduped.reduce<Record<string, number>>((counts, link) => {
    counts[link.type] = (counts[link.type] || 0) + 1;
    return counts;
  }, {});

  return {
    generated_at: new Date().toISOString(),
    repository_count: repositories.length,
    links: deduped,
    summary,
  };
}

function detectApiLinks(
  consumer: { path: string; name: string; cas: CASOutput },
  producer: { path: string; name: string; cas: CASOutput }
): CASCrossRepositoryLink[] {
  const links: CASCrossRepositoryLink[] = [];
  const apiExits = (consumer.cas.exit_points || []).filter(exitPoint => exitPoint.type === 'api' || exitPoint.type === 'webhook');
  const entries = (producer.cas.entry_points || []).filter(entryPoint => entryPoint.type === 'http' || entryPoint.type === 'route');

  for (const exitPoint of apiExits) {
    const exitRoute = normalizeRoute(exitPoint.target?.endpoint || exitPoint.target?.resource || exitPoint.name);
    if (!exitRoute) continue;

    for (const entryPoint of entries) {
      const entryRoute = normalizeRoute(entryPoint.trigger?.path || entryPoint.name);
      if (!entryRoute || !routesCompatible(exitRoute, entryRoute)) continue;

      links.push({
        id: crossRepoId('api', consumer.name, exitPoint.id, producer.name, entryPoint.id),
        type: 'api',
        source_repository: { path: consumer.path, node_ids: [exitPoint.source_node] },
        target_repository: { path: producer.path, node_ids: [entryPoint.source_node] },
        connection: {
          protocol: 'http',
          endpoint: entryPoint.trigger?.path || exitPoint.target?.endpoint,
          method: entryPoint.trigger?.method || exitPoint.operation?.method,
        },
        metadata: {
          verified: false,
          last_sync: new Date().toISOString(),
          confidence: exitRoute === entryRoute ? 0.9 : 0.65,
          evidence: [
            { kind: 'graph', source: `${consumer.name}:${exitPoint.id}`, confidence: 0.8 },
            { kind: 'route', source: `${producer.name}:${entryPoint.id}`, file: entryPoint.handler?.file, line: entryPoint.handler?.line, confidence: 0.8 },
          ],
        },
      });
    }
  }

  return links;
}

function detectSharedDatabaseLinks(
  left: { path: string; name: string; cas: CASOutput },
  right: { path: string; name: string; cas: CASOutput }
): CASCrossRepositoryLink[] {
  const links: CASCrossRepositoryLink[] = [];
  const leftResources = databaseResources(left.cas);
  const rightResources = databaseResources(right.cas);

  for (const leftResource of leftResources) {
    const rightResource = rightResources.find(candidate => candidate.key === leftResource.key);
    if (!rightResource) continue;

    links.push({
      id: crossRepoId('shared-database', left.name, leftResource.id, right.name, rightResource.id),
      type: 'shared-database',
      source_repository: { path: left.path, node_ids: leftResource.nodeId ? [leftResource.nodeId] : [] },
      target_repository: { path: right.path, node_ids: rightResource.nodeId ? [rightResource.nodeId] : [] },
      connection: { resource: leftResource.name } as any,
      metadata: {
        verified: false,
        last_sync: new Date().toISOString(),
        confidence: 0.75,
        evidence: [
          { kind: 'graph', source: `${left.name}:${leftResource.id}`, confidence: 0.75 },
          { kind: 'graph', source: `${right.name}:${rightResource.id}`, confidence: 0.75 },
        ],
      },
    });
  }

  return links;
}

function detectMessageLinks(
  producer: { path: string; name: string; cas: CASOutput },
  consumer: { path: string; name: string; cas: CASOutput }
): CASCrossRepositoryLink[] {
  const links: CASCrossRepositoryLink[] = [];
  const messageExits = (producer.cas.exit_points || []).filter(exitPoint => exitPoint.type === 'message' || exitPoint.type === 'event');
  const messageEntries = (consumer.cas.entry_points || []).filter(entryPoint => entryPoint.type === 'message' || entryPoint.type === 'event');

  for (const exitPoint of messageExits) {
    const exitTopic = normalizeTopic(exitPoint.target?.resource || exitPoint.name);
    if (!exitTopic) continue;

    for (const entryPoint of messageEntries) {
      const entryTopic = normalizeTopic(entryPoint.trigger?.event || entryPoint.name);
      if (!entryTopic || exitTopic !== entryTopic) continue;

      links.push({
        id: crossRepoId('message-contract', producer.name, exitPoint.id, consumer.name, entryPoint.id),
        type: 'message-contract',
        source_repository: { path: producer.path, node_ids: [exitPoint.source_node] },
        target_repository: { path: consumer.path, node_ids: [entryPoint.source_node] },
        connection: {
          routing_key: exitTopic,
          message_schema: exitPoint.data?.output_type || entryPoint.input?.schema,
        },
        metadata: {
          verified: false,
          last_sync: new Date().toISOString(),
          confidence: 0.8,
          evidence: [
            { kind: 'graph', source: `${producer.name}:${exitPoint.id}`, confidence: 0.8 },
            { kind: 'graph', source: `${consumer.name}:${entryPoint.id}`, confidence: 0.8 },
          ],
        },
      });
    }
  }

  return links;
}

function detectSharedLibraryLinks(
  left: { path: string; name: string; cas: CASOutput },
  right: { path: string; name: string; cas: CASOutput }
): CASCrossRepositoryLink[] {
  const links: CASCrossRepositoryLink[] = [];
  const leftLibraries = internalLibraries(left.cas);
  const rightLibraries = internalLibraries(right.cas);

  for (const library of leftLibraries) {
    const match = rightLibraries.find(candidate => candidate.name === library.name);
    if (!match) continue;

    links.push({
      id: crossRepoId('library', left.name, library.name, right.name, match.name),
      type: 'library',
      source_repository: { path: left.path },
      target_repository: { path: right.path },
      connection: {
        package_name: library.name,
        version: library.version || match.version,
      },
      metadata: {
        verified: false,
        last_sync: new Date().toISOString(),
        confidence: 0.7,
        evidence: [
          { kind: 'dependency', source: `${left.name}:${library.name}`, confidence: 0.7 },
          { kind: 'dependency', source: `${right.name}:${match.name}`, confidence: 0.7 },
        ],
      },
    });
  }

  return links;
}

export function correlateRuntimeEvent(cas: CASOutput, event: RuntimeEventInput): RuntimeCorrelationResult {
  const matches: EvidenceRef[] = [];
  const runtimeLinks = matchingRuntimeLinks(cas, event);

  for (const link of runtimeLinks) {
    matches.push(runtimeLinkRef(link));
    const staticRef = staticRefForId(cas, link.static_id, link.confidence);
    if (staticRef) matches.push(staticRef);
  }

  for (const staticId of [event.static_id, event.node_id, event.entry_point_id, event.exit_point_id, event.call_chain_id].filter(Boolean) as string[]) {
    const ref = staticRefForId(cas, staticId, 0.95);
    if (ref) matches.push(ref);
  }

  const routeMatch = matchRuntimeRoute(cas, event);
  if (routeMatch) matches.push(routeMatch);

  const stackMatches = matchStackFrames(cas, event.stack);
  matches.push(...stackMatches);

  const dedupedMatches = dedupeEvidence(matches);
  const bestMatch = dedupedMatches[0];
  const status = bestMatch
    ? dedupedMatches.length > 1 || runtimeLinks.length > 0 ? 'matched' : 'partial'
    : 'unmatched';

  return {
    status,
    best_match: bestMatch,
    matches: dedupedMatches,
    runtime_links: runtimeLinks,
    suggested_instrumentation: suggestInstrumentation(cas, event, dedupedMatches),
  };
}

export function buildMcpDemoFlow(cas: CASOutput, path: string, relatedPaths: string[] = []) {
  const answerPack = runAnswerPack(cas, path);
  const entryPoint = (cas.entry_points || [])[0];
  const targetNode = findMostConnectedNode(cas);

  return {
    path,
    generated_at: new Date().toISOString(),
    goal: 'Prove a codebase can be understood through MCP without rereading every file.',
    script: [
      { step: 1, tool: 'analyze_codebase', args: { path }, purpose: 'Build or refresh CAS.' },
      { step: 2, tool: 'run_answer_pack', args: { path, pack: 'mastery' }, purpose: 'Answer the core product questions with evidence.' },
      { step: 3, tool: 'get_entry_points', args: { path, limit: 10 }, purpose: 'Show concrete execution inputs.' },
      { step: 4, tool: 'get_call_chain', args: { path, entry_point_id: entryPoint?.id }, purpose: 'Trace behavior from an entry point.' },
      { step: 5, tool: 'get_coding_context', args: { path, target: targetNode?.id }, purpose: 'Show what an agent needs before modifying code.' },
      { step: 6, tool: 'get_cross_repo_links', args: { paths: [path, ...relatedPaths] }, purpose: 'Connect this repository to its neighbors.' },
      { step: 7, tool: 'get_runtime_static_links', args: { path, limit: 10 }, purpose: 'Show runtime signals that can map back to CAS.' },
    ],
    representative_entry_point: entryPoint || null,
    representative_target: targetNode ? summarizeNode(targetNode) : null,
    answer_pack: {
      status: answerPack.gaps.length === 0 ? 'ready' : 'needs-review',
      answer_count: answerPack.answers.length,
      gaps: answerPack.gaps,
      answers: answerPack.answers.map(answerValue => ({
        id: answerValue.id,
        confidence: answerValue.confidence,
        evidence_count: answerValue.evidence.length,
        follow_up_tools: answerValue.follow_up_tools,
      })),
    },
  };
}

function matchingRuntimeLinks(cas: CASOutput, event: RuntimeEventInput): CASRuntimeStaticLink[] {
  return (cas.runtime_static_links || []).filter(link => {
    if (event.static_id && link.static_id === event.static_id) return true;
    if (event.signal && normalizeSignal(link.runtime_signal) === normalizeSignal(event.signal)) return true;
    if (event.entry_point_id && link.static_id === event.entry_point_id) return true;
    if (event.exit_point_id && link.static_id === event.exit_point_id) return true;
    if (event.call_chain_id && link.static_id === event.call_chain_id) return true;
    return false;
  });
}

function matchRuntimeRoute(cas: CASOutput, event: RuntimeEventInput): EvidenceRef | undefined {
  const route = normalizeRoute(event.route || event.path || '');
  if (!route) return undefined;
  const method = event.method?.toUpperCase();
  const entryPoint = (cas.entry_points || []).find(candidate => {
    const candidateRoute = normalizeRoute(candidate.trigger?.path || candidate.name);
    const methodMatches = !method || !candidate.trigger?.method || candidate.trigger.method.toUpperCase() === method;
    return methodMatches && candidateRoute && routesCompatible(route, candidateRoute);
  });
  return entryPoint ? entryPointRef(entryPoint, 0.9) : undefined;
}

function matchStackFrames(cas: CASOutput, stack?: string): EvidenceRef[] {
  if (!stack) return [];
  const fileMatches = [...stack.matchAll(/(?:at\s+.*\()?([/\w.-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|cs|php)):(\d+):\d+\)?/g)];
  const refs: EvidenceRef[] = [];
  for (const match of fileMatches.slice(0, 5)) {
    const file = match[1];
    const line = Number(match[2]);
    const node = cas.nodes.find(candidate =>
      candidate.source?.file &&
      pathsCompatible(candidate.source.file, file) &&
      (!candidate.source.line || !candidate.source.end_line || (candidate.source.line <= line && candidate.source.end_line >= line))
    ) || cas.nodes.find(candidate => candidate.source?.file && pathsCompatible(candidate.source.file, file));

    if (node) refs.push(nodeRef(node, 0.75));
  }
  return refs;
}

function suggestInstrumentation(cas: CASOutput, event: RuntimeEventInput, matches: EvidenceRef[]): string[] {
  if (matches.length > 0) return [];
  const suggestions = ['Add a CAS static id to the runtime event payload.'];
  if (event.type === 'request') suggestions.push('Include HTTP method and normalized route pattern.');
  if (event.type === 'error') suggestions.push('Include stack trace, entry point id, and call chain id when available.');
  if ((cas.runtime_static_links || []).length > 0) suggestions.push('Use one of the instrumentable runtime_static_links as the emitted signal name.');
  return suggestions;
}

function findMostConnectedNode(cas: CASOutput): CASNode | undefined {
  const edgeCounts = new Map<string, number>();
  for (const edge of cas.edges) {
    edgeCounts.set(edge.source, (edgeCounts.get(edge.source) || 0) + 1);
    edgeCounts.set(edge.target, (edgeCounts.get(edge.target) || 0) + 1);
  }
  for (const call of cas.method_calls || []) {
    if (call.caller_node) edgeCounts.set(call.caller_node, (edgeCounts.get(call.caller_node) || 0) + 1);
    if (call.target_node) edgeCounts.set(call.target_node, (edgeCounts.get(call.target_node) || 0) + 1);
  }
  return [...cas.nodes]
    .filter(node => node.type !== 'file' && node.type !== 'import')
    .sort((a, b) => (edgeCounts.get(b.id) || 0) - (edgeCounts.get(a.id) || 0))[0];
}

function nodesForChain(cas: CASOutput, chain?: CASCallChain): CASNode[] {
  if (!chain) return [];
  return idsToNodes(cas, chain.call_path.map(step => step.node_id));
}

function idsToNodes(cas: CASOutput, ids: string[]): CASNode[] {
  const nodeById = new Map(cas.nodes.map(node => [node.id, node]));
  return ids.map(id => nodeById.get(id)).filter((node): node is CASNode => Boolean(node));
}

function summarizeNode(node: CASNode) {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    file: node.source?.file,
    line: node.source?.line,
  };
}

function nodeEvidence(nodes: CASNode[]): EvidenceRef[] {
  return nodes.map(node => nodeRef(node));
}

function nodeRef(node: CASNode, confidenceValue = 0.9): EvidenceRef {
  return {
    type: 'node',
    id: node.id,
    label: `${node.type}:${node.name}`,
    file: node.source?.file,
    line: node.source?.line,
    confidence: confidenceValue,
  };
}

function entryPointEvidence(entryPoints: CASEntryPoint[]): EvidenceRef[] {
  return entryPoints.map(entryPoint => entryPointRef(entryPoint));
}

function entryPointRef(entryPoint: CASEntryPoint, confidenceValue = 0.9): EvidenceRef {
  return {
    type: 'entry_point',
    id: entryPoint.id,
    label: entryPoint.name,
    file: entryPoint.handler?.file,
    line: entryPoint.handler?.line,
    confidence: confidenceValue,
  };
}

function exitPointEvidence(exitPoints: CASExitPoint[]): EvidenceRef[] {
  return exitPoints.map(exitPoint => ({
    type: 'exit_point',
    id: exitPoint.id,
    label: exitPoint.name,
    confidence: 0.9,
  }));
}

function callChainEvidence(chains: CASCallChain[]): EvidenceRef[] {
  return chains.map(chain => ({
    type: 'call_chain',
    id: chain.id,
    label: chain.chain_type,
    confidence: 0.9,
  }));
}

function runtimeLinkEvidence(links: CASRuntimeStaticLink[]): EvidenceRef[] {
  return links.map(runtimeLinkRef);
}

function runtimeLinkRef(link: CASRuntimeStaticLink): EvidenceRef {
  return {
    type: 'runtime_link',
    id: link.id,
    label: link.runtime_signal,
    confidence: link.confidence,
  };
}

function summaryEvidence(id: string, label: string): EvidenceRef {
  return { type: 'summary', id, label, confidence: 0.9 };
}

function staticRefForId(cas: CASOutput, id: string, confidenceValue = 0.9): EvidenceRef | undefined {
  const node = cas.nodes.find(candidate => candidate.id === id);
  if (node) return nodeRef(node, confidenceValue);
  const entryPoint = (cas.entry_points || []).find(candidate => candidate.id === id);
  if (entryPoint) return entryPointRef(entryPoint, confidenceValue);
  const exitPoint = (cas.exit_points || []).find(candidate => candidate.id === id);
  if (exitPoint) return { type: 'exit_point', id, label: exitPoint.name, confidence: confidenceValue };
  const chain = (cas.call_chains || []).find(candidate => candidate.id === id);
  if (chain) return { type: 'call_chain', id, label: chain.chain_type, confidence: confidenceValue };
  return undefined;
}

function confidence(...conditions: boolean[]): number {
  if (conditions.length === 0) return 0.85;
  const met = conditions.filter(Boolean).length;
  return Math.max(0.6, Math.round((met / conditions.length) * 100) / 100);
}

function databaseResources(cas: CASOutput): Array<{ id: string; key: string; name: string; nodeId?: string }> {
  const resources: Array<{ id: string; key: string; name: string; nodeId?: string }> = [];

  for (const entity of cas.database_schema?.entities || []) {
    const name = entity.table || entity.name;
    resources.push({ id: `schema:${name}`, key: normalizeTopic(name), name });
  }

  for (const exitPoint of cas.exit_points || []) {
    if (exitPoint.type !== 'database') continue;
    const name = exitPoint.target?.resource || exitPoint.name;
    resources.push({ id: exitPoint.id, key: normalizeTopic(name), name, nodeId: exitPoint.source_node });
  }

  return dedupeBy(resources, resource => resource.key);
}

function internalLibraries(cas: CASOutput): Array<{ name: string; version?: string }> {
  return (cas.libraries || [])
    .filter(library => {
      const name = library.name.toLowerCase();
      return name.startsWith('@') || name.includes('unravl') || name.includes('zerac') || name.includes('soon') || name.includes('kadra');
    })
    .map(library => ({ name: library.name, version: library.version }));
}

function normalizeRoute(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/\?.*$/, '')
    .replace(/:[a-z0-9_]+/g, ':param')
    .replace(/\{[^}]+\}/g, ':param')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
}

function routesCompatible(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.includes(':param') || right.includes(':param')) {
    const leftParts = left.split('/');
    const rightParts = right.split('/');
    if (leftParts.length !== rightParts.length) return false;
    return leftParts.every((part, index) => part === rightParts[index] || part === ':param' || rightParts[index] === ':param');
  }
  return left.endsWith(right) || right.endsWith(left);
}

function normalizeTopic(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalizeSignal(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9:./_-]+/g, '');
}

function pathsCompatible(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/\\/g, '/');
  const normalizedRight = right.replace(/\\/g, '/');
  return normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`);
}

function crossRepoId(type: string, sourceName: string, sourceId: string, targetName: string, targetId: string): string {
  return `${type}:${normalizeTopic(sourceName)}:${normalizeTopic(sourceId)}:${normalizeTopic(targetName)}:${normalizeTopic(targetId)}`;
}

function dedupeLinks(links: CASCrossRepositoryLink[]): CASCrossRepositoryLink[] {
  return dedupeBy(links, link => link.id);
}

function dedupeEvidence(evidence: EvidenceRef[]): EvidenceRef[] {
  return dedupeBy(evidence, ref => `${ref.type}:${ref.id}`);
}

function dedupeBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
