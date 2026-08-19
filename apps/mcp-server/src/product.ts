import type {
  CASCallChain,
  CASCrossRepositoryLink,
  CASEntryPoint,
  CASExitPoint,
  FlowConcept,
  CASNode,
  CASOutput,
  CASRuntimeStaticLink,
} from '../../../packages/analyzer-core/src/types/cas.types';
import {
  assessChangeRisk,
  buildSummary,
  findTests,
  getCallChain,
  getCallers,
  getCallees,
  getBehavioralInvariants,
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
import { classifyAnalysisProfile, shouldSuppressAnswerGap } from './analysis-profile';
import { RESPONSE_BUDGET_BYTES } from './response-budget';
import {
  entityShapesCompatible,
  entityTypeNodes,
  entityVocabulary,
  isNonRuntimeSourceFile,
  repositoryAffinityScore,
  type EntityContractEvidence,
} from './cross-repository-evidence';

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

export interface AnswerPackDigest {
  pack: string;
  path: string;
  generated_at: string;
  gaps: string[];
  full_size_bytes: number;
  truncated: boolean;
  sections: Array<{
    id: string;
    question: string;
    confidence: number;
    size_bytes: number;
    included: boolean;
    fetch_with?: { tool: 'run_answer_pack'; args: { path: string; pack: string; section: string } };
  }>;
  answers: AnswerPackResult['answers'];
  continuation: string;
}

export function buildAnswerPackDigest(result: AnswerPackResult, budgetBytes = RESPONSE_BUDGET_BYTES): AnswerPackDigest {
  const sized = result.answers.map(item => ({
    item,
    size: Buffer.byteLength(JSON.stringify(item), 'utf8'),
  }));
  const fullSize = sized.reduce((sum, entry) => sum + entry.size, 0);
  const inlineBudget = Math.floor(budgetBytes * 0.6);
  const included = new Set<string>();
  let used = 0;
  for (const entry of [...sized].sort((a, b) => a.size - b.size)) {
    if (used + entry.size > inlineBudget) continue;
    included.add(entry.item.id);
    used += entry.size;
  }
  return {
    pack: result.pack,
    path: result.path,
    generated_at: result.generated_at,
    gaps: result.gaps,
    full_size_bytes: fullSize,
    truncated: included.size < result.answers.length,
    sections: sized.map(({ item, size }) => ({
      id: item.id,
      question: item.question,
      confidence: item.confidence,
      size_bytes: size,
      included: included.has(item.id),
      ...(included.has(item.id)
        ? {}
        : { fetch_with: { tool: 'run_answer_pack' as const, args: { path: result.path, pack: result.pack, section: item.id } } }),
    })),
    answers: result.answers.filter(item => included.has(item.id)),
    continuation: included.size < result.answers.length
      ? "Sections with included=false were withheld to stay within the response budget. Fetch each one in full with run_answer_pack { path, pack, section: '<id>' }; never request the whole pack expecting unbounded output."
      : 'All sections fit within the response budget.',
  };
}

export interface RuntimeEventInput {
  type: 'request' | 'error' | 'exit' | 'log' | 'custom';
  timestamp?: string;
  schema_version?: string;
  service_name?: string;
  environment?: string;
  signal?: string;
  static_id?: string;
  node_id?: string;
  entry_point_id?: string;
  exit_point_id?: string;
  call_chain_id?: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  method?: string;
  route?: string;
  path?: string;

  endpoint?: string;
  target?: string;
  status_code?: number;
  duration_ms?: number;
  error_message?: string;
  stack?: string;
  attributes?: Record<string, unknown>;
}

export interface RuntimeImpactStats {
  observations: number;

  request_count: number;
  errors: number;

  error_count: number;
  slow_events: number;
  estimated_volume: number;
  traces: number;

  last_seen?: string;

  status_code_distribution: Record<string, number>;
  latency: {
    avg_ms?: number;
    max_ms?: number;
    p50_ms?: number;
    p95_ms?: number;
    p99_ms?: number;
  };
  rates: {
    error_rate: number;
    throughput_per_min?: number;
  };
}

export interface NodeRuntimeMetrics {

  static_id: string;
  node_id?: string;
  entry_point_id?: string;
  label: string;
  type: EvidenceRef['type'] | 'unmatched';
  file?: string;
  route?: string;
  method?: string;

  request_count: number;
  throughput_per_min?: number;

  error_count: number;
  error_rate: number;
  status_code_distribution: Record<string, number>;

  latency: RuntimeImpactStats['latency'];
  slow_events: number;
  observations: number;
  traces: number;
  last_seen?: string;
  source: RuntimeObservationSource | 'mixed';
}

export type RuntimeObservationSource = 'ingested' | 'simulated';

export interface RuntimeObservation {
  id: string;
  project_path: string;
  recorded_at: string;
  source?: RuntimeObservationSource;
  event: RuntimeEventInput & { timestamp: string };
  correlation: RuntimeCorrelationResult;
}

export function runtimeObservationSource(observation: RuntimeObservation): RuntimeObservationSource {
  if (observation.source) return observation.source;
  const event = observation.event;
  const simulated = event.attributes?.simulated === true ||
    event.environment === 'simulation' ||
    String(event.schema_version || '').startsWith('simulated');
  return simulated ? 'simulated' : 'ingested';
}

export interface RuntimeCorrelationResult {
  status: 'matched' | 'partial' | 'unmatched';
  best_match?: EvidenceRef;
  matches: EvidenceRef[];
  runtime_links: CASRuntimeStaticLink[];
  suggested_instrumentation: string[];
}

export interface OperationalPriority {
  id: string;
  title: string;
  priority_score: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  source: RuntimeObservationSource | 'mixed';
  static_target?: EvidenceRef;
  runtime: {
    observations: number;
    errors: number;
    slow_events: number;
    estimated_volume: number;
    traces: number;
    latency?: RuntimeImpactStats['latency'];
    rates?: RuntimeImpactStats['rates'];
  };
  static_risk: {
    system_health_risk?: string;
    change_risk?: string;
    untested?: boolean;
  };
  recommendation: string;
  agent_guidance: string[];
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

export function describeAnswerPackCatalog(): string {
  return getAnswerPackCatalog()
    .map(pack => `'${pack.id}' (sections: ${pack.questions.map(question => question.id).join(', ')})`)
    .join('; ');
}

export function runAnswerPack(cas: CASOutput, path: string, pack = 'mastery'): AnswerPackResult {
  if (pack !== 'mastery') {
    return {
      pack,
      path,
      generated_at: new Date().toISOString(),
      answers: [],
      gaps: [
        `Unknown answer pack: ${pack}. Available packs: ${describeAnswerPackCatalog()}. Retry with pack: 'mastery', optionally narrowed with section: '<id>'.`,
      ],
    };
  }

  const gaps: string[] = [];
  const profile = classifyAnalysisProfile(cas, path);
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
    if (answer.confidence < 0.8 && !shouldSuppressAnswerGap(profile, answer.id)) {
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
  const flow = selectRepresentativeFlow(cas.flows || [], cas.entry_points || []);
  const entryPoint = (cas.entry_points || []).find(entry => entry.id === flow?.entry_point) || (cas.entry_points || []).find(entry =>
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
    flow,
    chain,
  }, [
    ...entryPointEvidence([entryPoint]),
    ...(flow ? flowEvidence(flow) : []),
    ...(chain ? callChainEvidence([chain]) : []),
    ...nodeEvidence(nodesForRepresentativeFlow(cas, flow, chain).slice(0, 8)),
  ], confidence(Boolean(flow || chain), Boolean(entryPoint)));
}

function selectRepresentativeFlow(flows: FlowConcept[], entryPoints: CASEntryPoint[]): FlowConcept | undefined {
  const entryTypes = new Map(entryPoints.map(entry => [entry.id, entry.type]));
  return [...flows].sort((left, right) => flowInformationScore(right, entryTypes) - flowInformationScore(left, entryTypes) || left.flow_id.localeCompare(right.flow_id))[0];
}

function flowInformationScore(flow: FlowConcept, entryTypes: Map<string, string>): number {
  const entryType = entryTypes.get(flow.entry_point);
  const userFacingWeight = ['http', 'graphql', 'rpc', 'websocket', 'event', 'message'].includes(entryType || '') ? 20 : 0;
  return flow.steps.length * 2
    + flow.entities.length * 10
    + flow.contract.input.length
    + flow.contract.output.length
    + flow.contract.side_effects.state_changes.length * 8
    + flow.contract.side_effects.external_integrations.length
    + userFacingWeight
    + (flow.terminus ? 3 : 0);
}

function flowEvidence(flow: FlowConcept): EvidenceRef[] {
  return [{ type: 'fact', id: flow.flow_id, label: flow.name, confidence: 0.9 }];
}

function nodesForRepresentativeFlow(cas: CASOutput, flow: FlowConcept | undefined, chain: CASCallChain | undefined): CASNode[] {
  if (!flow) return nodesForChain(cas, chain);
  const ids = new Set(flow.steps.flatMap(step => step.functions.map(fn => fn.function_id)));
  return cas.nodes.filter(node => ids.has(node.id));
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
  const invariants = getBehavioralInvariants(cas, { invariantType: 'tenant-scope', limit: 10 });
  const hasData = dataEntities.total > 0 || databaseExits.total > 0 || Boolean(cas.database_schema?.entities?.length);
  return answer('data', {
    entities: dataEntities,
    database_schema: cas.database_schema || null,
    database_exit_points: databaseExits,
    behavioral_invariants: invariants,
  }, [
    summaryEvidence('data-summary', hasData ? 'CAS data surfaces found' : 'CAS reports no data surface'),
    ...dataEntities.entities.slice(0, 8).map(entity => ({ type: 'data_entity' as const, id: entity.id, label: entity.name })),
    ...exitPointEvidence(databaseExits.exit_points),
  ], hasData ? 0.95 : 0.85);
}

function answerTests(cas: CASOutput) {
  const tests = findTests(cas, { limit: 15 });
  const flowCoverage = getFlowCoverage(cas) as Record<string, unknown>;
  const invariants = getBehavioralInvariants(cas, { invariantType: 'test-coverage', limit: 5 });
  return answer('tests', {
    tests,
    flow_coverage: flowCoverage,
    behavioral_invariants: invariants,
  }, [
    summaryEvidence('test-summary', tests.total_suites > 0 ? 'CAS test suites found' : 'CAS reports no test suites'),
    ...tests.suites.slice(0, 8).map(suite => ({ type: 'test' as const, id: suite.file_path, label: suite.name, file: suite.file_path })),
  ], tests.total_suites > 0 ? 0.95 : 0.85);
}

function answerExternalBoundaries(cas: CASOutput) {
  const exits = getExitPoints(cas, { limit: 20 });
  const externalServices = getExternalServices(cas);
  const hasExternalBoundaries = exits.total > 0 || externalServices.length > 0;
  return answer('external-boundaries', {
    exit_points: exits,
    external_services: externalServices,
  }, [
    summaryEvidence('external-boundary-summary', hasExternalBoundaries ? 'CAS external boundaries found' : 'CAS reports no external boundaries'),
    ...exitPointEvidence(exits.exit_points),
  ], hasExternalBoundaries ? 0.95 : 0.85);
}
function answerSecurity(cas: CASOutput) {
  const security = getSecurityOverview(cas);
  const authNodes = searchNodes(cas, 'auth', { limit: 15 });
  const invariants = getBehavioralInvariants(cas, { invariantType: 'auth-boundary', limit: 10 });
  const hasSecurity = security.boundary_count > 0 || security.context_count > 0 || authNodes.length > 0;
  return answer('security', {
    security,
    auth_nodes: authNodes,
    behavioral_invariants: invariants,
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
  certainty: {
    confirmed: number;
    likely: number;
    possible: number;
    conflicts: number;
  };
  conflicts: Array<{
    id: string;
    link_ids: string[];
    reason: string;
  }>;
} {
  const links: CASCrossRepositoryLink[] = [];

  for (let leftIndex = 0; leftIndex < repositories.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < repositories.length; rightIndex++) {
      const left = repositories[leftIndex];
      const right = repositories[rightIndex];
      const directLinks = [
        ...detectApiLinks(left, right),
        ...detectApiLinks(right, left),
        ...detectSharedDatabaseLinks(left, right),
        ...detectMessageLinks(left, right),
        ...detectMessageLinks(right, left),
        ...detectExternalServiceLinks(left, right),
        ...detectExternalServiceLinks(right, left),
        ...detectEnvironmentContractLinks(left, right),
        ...detectEnvironmentContractLinks(right, left),
        ...detectNamespaceImportLinks(left, right),
        ...detectNamespaceImportLinks(right, left),
      ];
      const hasDirectContract = directLinks.some(link => (link.metadata?.confidence || 0) >= 0.75);
      links.push(...directLinks);
      links.push(...detectSharedSchemaLinks(left, right, hasDirectContract));
      links.push(...detectSharedLibraryLinks(left, right));
      links.push(...detectSharedEntityLinks(left, right, hasDirectContract));
    }
  }

  const deduped = dedupeLinks(links);
  const summary = deduped.reduce<Record<string, number>>((counts, link) => {
    counts[link.type] = (counts[link.type] || 0) + 1;
    return counts;
  }, {});
  const conflicts = findCrossRepoLinkConflicts(deduped);
  const certainty = deduped.reduce(
    (counts, link) => {
      const band = certaintyBand(link.metadata?.confidence || 0);
      counts[band]++;
      return counts;
    },
    { confirmed: 0, likely: 0, possible: 0, conflicts: conflicts.length }
  );

  return {
    generated_at: new Date().toISOString(),
    repository_count: repositories.length,
    links: deduped,
    summary,
    certainty,
    conflicts,
  };
}

export interface CrossRepoRouteDrift {
  kind: 'missing-route' | 'near-miss';
  method?: string;
  path: string;
  consumer_repo: string;
  consumer_file?: string;
  consumer_symbol?: string;
  nearest_backend_route?: {
    method?: string;
    path: string;
    provider_repo: string;
    similarity: number;
  };
  confidence: number;
}

export function buildCrossRepoRouteDrift(
  repositories: Array<{ path: string; name: string; cas: CASOutput }>
): CrossRepoRouteDrift[] {
  const findings: CrossRepoRouteDrift[] = [];

  for (const consumer of repositories) {
    const producerRoutes = repositories
      .filter(repository => repository.path !== consumer.path)
      .flatMap(producer =>
        (producer.cas.entry_points || [])
          .filter(entryPoint => isApiProviderEntry(producer.cas, entryPoint))
          .map(entryPoint => ({
            provider_repo: producer.name,
            method: normalizeHttpMethod(entryPoint.trigger?.method),
            path: entryPoint.trigger?.path || entryPoint.name,
            route: normalizeRoute(entryPoint.trigger?.path || entryPoint.name),
          }))
          .filter(route => route.route && route.route !== '/')
      );
    if (producerRoutes.length === 0) continue;

    const seen = new Set<string>();
    const apiExits = (consumer.cas.exit_points || []).filter(exitPoint =>
      exitPoint.type === 'api' || exitPoint.type === 'webhook'
    );

    for (const exitPoint of apiExits) {
      const rawTarget = exitPoint.target?.endpoint || exitPoint.target?.resource || exitPoint.name;
      if (!isRouteDriftCandidate(rawTarget)) continue;
      const exitRoute = normalizeRoute(rawTarget);
      const exitMethod = normalizeHttpMethod(exitPoint.operation?.method || exitPoint.operation?.action);

      const matched = producerRoutes.some(route =>
        routesCompatible(exitRoute, route.route) &&
        (!exitMethod || !route.method || exitMethod === 'FETCH' || route.method === 'ALL' || exitMethod === route.method)
      );
      if (matched) continue;

      const consumerNode = consumer.cas.nodes.find(node => node.id === exitPoint.source_node);
      const dedupeKey = `${exitMethod || '*'} ${exitRoute} ${consumerNode?.source?.file || ''}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      let nearest: typeof producerRoutes[number] | undefined;
      let bestSimilarity = 0;
      for (const route of producerRoutes) {
        const similarity = routeSegmentSimilarity(exitRoute, route.route);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          nearest = route;
        }
      }

      const kind: CrossRepoRouteDrift['kind'] = bestSimilarity >= 0.7 ? 'near-miss' : 'missing-route';
      const unresolvedPrefix = exitRoute.startsWith('/:param');
      const confidence = Math.round(((kind === 'missing-route' ? 0.85 : 0.7) - (unresolvedPrefix ? 0.15 : 0)) * 100) / 100;

      findings.push({
        kind,
        method: exitMethod,
        path: rawTarget,
        consumer_repo: consumer.name,
        consumer_file: consumerNode?.source?.file,
        consumer_symbol: consumerNode?.name,
        nearest_backend_route: nearest && bestSimilarity >= 0.4
          ? {
            method: nearest.method,
            path: nearest.path,
            provider_repo: nearest.provider_repo,
            similarity: Math.round(bestSimilarity * 100) / 100,
          }
          : undefined,
        confidence,
      });
    }
  }

  return findings.sort((left, right) => {
    if (right.confidence !== left.confidence) return right.confidence - left.confidence;
    return left.path.localeCompare(right.path);
  });
}

export type ContractDriftKind = 'type-changed' | 'field-renamed' | 'field-removed' | 'field-added';

export interface ContractFieldDrift {
  field: string;
  producer_type?: string;
  consumer_type?: string;
  kind: ContractDriftKind;
}

export interface CrossRepoContractDrift {
  seam: {
    method?: string;
    endpoint?: string;
    consumer_repo: string;
    producer_repo: string;
    contract: string;
  };
  drift: ContractFieldDrift[];
  confidence: number;
}

interface EntityShape {
  name: string;
  fields: Map<string, { type: string; sensitive: boolean }>;
}

function entityShapes(cas: CASOutput): EntityShape[] {
  const shapes: EntityShape[] = [];
  for (const entity of cas.entities || []) {
    if (!entity.fields || entity.fields.length === 0) continue;
    const fields = new Map<string, { type: string; sensitive: boolean }>();
    for (const field of entity.fields) {
      fields.set(field.name, { type: (field.type || 'unknown'), sensitive: Boolean(field.is_sensitive) });
    }
    shapes.push({ name: entity.name, fields });
  }
  return shapes;
}

function contractNameFromRoute(route: string): string | undefined {
  const segments = routeSegments(normalizeRoute(route)).filter(
    seg => seg && seg !== 'api' && !/^v\d+$/.test(seg) && seg !== ':param' && !seg.startsWith(':')
  );
  const noun = segments[segments.length - 1];
  if (!noun) return undefined;

  if (/ies$/i.test(noun)) return noun.replace(/ies$/i, 'y');
  if (/(s|sh|ch|x|z)es$/i.test(noun)) return noun.replace(/es$/i, '');
  if (/s$/i.test(noun) && !/ss$/i.test(noun)) return noun.replace(/s$/i, '');
  return noun;
}

function matchShapeByName(shapes: EntityShape[], contract: string): EntityShape | undefined {
  const target = contract.toLowerCase();
  return (
    shapes.find(shape => shape.name.toLowerCase() === target) ||
    shapes.find(shape => shape.name.toLowerCase().replace(/(dto|entity|model|response|record)$/i, '') === target) ||
    shapes.find(shape => shape.name.toLowerCase().includes(target))
  );
}

function diffShapes(producer: EntityShape, consumer: EntityShape): ContractFieldDrift[] {
  const drift: ContractFieldDrift[] = [];

  for (const [name, producerField] of producer.fields) {
    const consumerField = consumer.fields.get(name);
    if (!consumerField) {

      drift.push({ field: name, producer_type: producerField.type, kind: 'field-removed' });
      continue;
    }
    if (
      producerField.type !== 'unknown' &&
      consumerField.type !== 'unknown' &&
      producerField.type !== consumerField.type
    ) {
      drift.push({
        field: name,
        producer_type: producerField.type,
        consumer_type: consumerField.type,
        kind: 'type-changed',
      });
    }
  }

  for (const [name, consumerField] of consumer.fields) {
    if (producer.fields.has(name)) continue;
    drift.push({ field: name, consumer_type: consumerField.type, kind: 'field-added' });
  }

  const removed = drift.filter(d => d.kind === 'field-removed');
  const added = drift.filter(d => d.kind === 'field-added');
  for (const r of removed) {
    const match = added.find(a => a.consumer_type && a.consumer_type === r.producer_type);
    if (!match) continue;
    drift.push({
      field: `${r.field} -> ${match.field}`,
      producer_type: r.producer_type,
      consumer_type: match.consumer_type,
      kind: 'field-renamed',
    });
    r.kind = '__consumed' as ContractDriftKind;
    match.kind = '__consumed' as ContractDriftKind;
  }

  return drift.filter(d => (d.kind as string) !== '__consumed');
}

export function buildCrossRepoContractDrift(
  repositories: Array<{ path: string; name: string; cas: CASOutput }>
): CrossRepoContractDrift[] {
  const findings: CrossRepoContractDrift[] = [];
  const links = buildCrossRepositoryLinks(repositories).links.filter(link => link.type === 'api');
  const byPath = new Map(repositories.map(repo => [repo.path, repo]));
  const seen = new Set<string>();

  for (const link of links) {
    const consumer = byPath.get(link.source_repository?.path || '');
    const producer = byPath.get(link.target_repository?.path || '');
    if (!consumer || !producer) continue;

    const endpoint = link.connection?.endpoint;
    const method = link.connection?.method ? String(link.connection.method).toUpperCase() : undefined;
    const contract = endpoint ? contractNameFromRoute(endpoint) : undefined;
    if (!contract) continue;

    const dedupeKey = `${consumer.path}->${producer.path}:${method || '*'}:${endpoint}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const producerShape = matchShapeByName(entityShapes(producer.cas), contract);
    const consumerShape = matchShapeByName(entityShapes(consumer.cas), contract);

    if (!producerShape || !consumerShape) continue;

    const drift = diffShapes(producerShape, consumerShape);
    if (drift.length === 0) continue;

    findings.push({
      seam: {
        method,
        endpoint,
        consumer_repo: consumer.name,
        producer_repo: producer.name,
        contract,
      },
      drift,
      confidence: link.metadata?.confidence ?? 0.8,
    });
  }

  return findings.sort((a, b) => (a.seam.endpoint || '').localeCompare(b.seam.endpoint || ''));
}

function isRouteDriftCandidate(value: string): boolean {
  if (!value || !looksLikeHttpPath(value)) return false;
  if (/^https?:\/\//i.test(value)) {
    try {
      const host = new URL(value).hostname.toLowerCase();
      if (host !== 'localhost' && host !== '127.0.0.1' && !host.endsWith('.local')) return false;
    } catch {
      return false;
    }
  }
  const route = normalizeRoute(value);
  if (!route || route === '/') return false;
  return routeSegments(route).some(segment => segment === 'api' || /^v\d+$/.test(segment));
}

function routeSegmentSimilarity(left: string, right: string): number {
  const leftParts = routeSegments(left);
  const rightParts = routeSegments(right);
  if (leftParts.length === 0 || rightParts.length === 0) return 0;
  if (leftParts.length === rightParts.length) {
    const total = leftParts.reduce((sum, part, index) => sum + segmentSimilarity(part, rightParts[index]), 0);
    return total / leftParts.length;
  }
  const matches = fuzzySegmentLcs(leftParts, rightParts);
  return matches / Math.max(leftParts.length, rightParts.length);
}

function segmentSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left === ':param' || right === ':param') return 0.35;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (longer.startsWith(shorter) && longer.length - shorter.length <= 2) return 0.85;
  return 0;
}

function fuzzySegmentLcs(leftParts: string[], rightParts: string[]): number {
  const table: number[][] = Array.from({ length: leftParts.length + 1 }, () => new Array(rightParts.length + 1).fill(0));
  for (let leftIndex = 1; leftIndex <= leftParts.length; leftIndex++) {
    for (let rightIndex = 1; rightIndex <= rightParts.length; rightIndex++) {
      const score = segmentSimilarity(leftParts[leftIndex - 1], rightParts[rightIndex - 1]);
      table[leftIndex][rightIndex] = Math.max(
        table[leftIndex - 1][rightIndex],
        table[leftIndex][rightIndex - 1],
        score > 0 ? table[leftIndex - 1][rightIndex - 1] + score : 0
      );
    }
  }
  return table[leftParts.length][rightParts.length];
}

function detectApiLinks(
  consumer: { path: string; name: string; cas: CASOutput },
  producer: { path: string; name: string; cas: CASOutput }
): CASCrossRepositoryLink[] {
  const links: CASCrossRepositoryLink[] = [];
  const apiExits = (consumer.cas.exit_points || []).filter(exitPoint => exitPoint.type === 'api' || exitPoint.type === 'webhook');
  const entries = (producer.cas.entry_points || []).filter(entryPoint => isApiProviderEntry(producer.cas, entryPoint));

  for (const exitPoint of apiExits) {
    const rawExitTarget = exitPoint.target?.endpoint || exitPoint.target?.resource || exitPoint.name;
    if (!looksLikeHttpPath(rawExitTarget)) continue;
    const exitRoute = normalizeRoute(rawExitTarget);
    if (!exitRoute || exitRoute === '/' || isExternalAbsoluteEndpoint(rawExitTarget)) continue;
    const exitMethod = normalizeHttpMethod(exitPoint.operation?.method || exitPoint.operation?.action);

    for (const entryPoint of entries) {
      const entryRoute = normalizeRoute(entryPoint.trigger?.path || entryPoint.name);
      if (!entryRoute || !routesCompatible(exitRoute, entryRoute)) continue;
      const entryMethod = normalizeHttpMethod(entryPoint.trigger?.method);
      const methodCompatible = !exitMethod || !entryMethod || exitMethod === 'FETCH' || entryMethod === 'ALL' || exitMethod === entryMethod;
      if (!methodCompatible) continue;

      const affinityScore = repositoryAffinityScore(consumer, producer);
      if (affinityScore === 0 && isGenericApiRoute(exitRoute, entryRoute)) continue;

      const routeScore = routeMatchScore(exitRoute, entryRoute);
      const methodScore = !exitMethod || exitMethod === 'FETCH' || !entryMethod || entryMethod === 'ALL' ? 0.86 : 1;
      const confidenceValue = Math.min(0.98, Math.round((routeScore * methodScore + affinityScore) * 100) / 100);

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
          verified: confidenceValue >= 0.9,
          last_sync: new Date().toISOString(),
          confidence: confidenceValue,
          evidence: [
            { kind: 'graph', source: `${consumer.name}:${exitPoint.id}`, confidence: 0.85 },
            { kind: 'route', source: `${producer.name}:${entryPoint.id}`, file: entryPoint.handler?.file, line: entryPoint.handler?.line, confidence: 0.9 },
            ...(affinityScore > 0 ? [{ kind: 'naming' as const, source: `${consumer.name}<->${producer.name}`, confidence: affinityScore }] : []),
          ],
        },
      });
    }
  }

  return links;
}

function isApiProviderEntry(cas: CASOutput, entryPoint: CASEntryPoint): boolean {
  if (entryPoint.type === 'http') return true;
  if (entryPoint.type !== 'route') return false;
  const sourceAnalyzer = (entryPoint.source_analyzer || '').toLowerCase();
  const entryFramework = String(entryPoint.metadata?.framework || '').toLowerCase();
  if (sourceAnalyzer === 'react' || sourceAnalyzer === 'react-router' || entryFramework === 'react-router') return false;
  const node = cas.nodes.find(candidate => candidate.id === entryPoint.source_node || candidate.id === entryPoint.handler?.node_id);
  const framework = node?.metadata?.framework?.toLowerCase() || '';
  const nodeType = node?.type?.toLowerCase() || '';
  const file = node?.source?.file?.toLowerCase() || entryPoint.handler?.file?.toLowerCase() || '';
  if (isNonRuntimeSourceFile(file)) return false;
  if (framework.includes('react') || nodeType.includes('component') || nodeType.includes('page')) return false;
  if (nodeType === 'react_route' || nodeType === 'react_page') return false;
  if (file.includes('/pages/') && !file.includes('/api/')) return false;
  if (file.includes('/app/') && !file.includes('/api/')) return false;
  if (isFrontendRouteFile(file) && !file.includes('/api/')) return false;
  return Boolean(entryPoint.trigger?.method || entryPoint.trigger?.path);
}

function isFrontendRouteFile(file: string): boolean {
  if (!file) return false;
  const frontendSegments = [
    '/legacy/web/',
    '/vault_legacy/web/',
    '/admin-ui/',
    '/user-ui/',
    '/client/',
    '/web/',
  ];
  if (frontendSegments.some(segment => file.includes(segment))) return true;
  return file.endsWith('/src/app.tsx') ||
    file.endsWith('/src/app.jsx') ||
    file.endsWith('/src/app.ts') ||
    file.endsWith('/src/app.js');
}

function isExternalAbsoluteEndpoint(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return false;
    return normalizeRoute(value) === '/' || !value.includes('/api/');
  } catch {
    return false;
  }
}

function isGenericApiRoute(...routes: string[]): boolean {
  const generic = new Set([
    'auth',
    'login',
    'logout',
    'register',
    'signup',
    'signin',
    'users',
    'user',
    'profile',
    'account',
    'accounts',
    'health',
    'status',
    'me',
  ]);

  return routes.some(route => {
    const topics = route.split('/')
      .filter(Boolean)
      .map(part => part.toLowerCase())
      .filter(part => !part.startsWith(':') && !/^v\d+$/.test(part) && part !== 'api');
    if (topics.length === 0) return true;
    if (topics.length > 2) return false;
    return topics.every(topic => generic.has(topic));
  });
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
        verified: true,
        last_sync: new Date().toISOString(),
        confidence: 0.88,
        evidence: [
          { kind: 'graph', source: `${left.name}:${leftResource.id}`, confidence: 0.88 },
          { kind: 'graph', source: `${right.name}:${rightResource.id}`, confidence: 0.88 },
        ],
      },
    });
  }

  return links;
}

function detectExternalServiceLinks(
  consumer: { path: string; name: string; cas: CASOutput },
  producer: { path: string; name: string; cas: CASOutput }
): CASCrossRepositoryLink[] {
  const links: CASCrossRepositoryLink[] = [];
  const services = consumer.cas.external_services || [];
  const producerNames = producerServiceNames(producer);
  const producerEntries = (producer.cas.entry_points || []).filter(entryPoint =>
    ['http', 'route', 'websocket', 'event', 'message'].includes(entryPoint.type)
  );

  for (const service of services) {
    if (!service.endpoint) continue;
    const serviceKey = normalizeServiceKey(service.name || service.endpoint || service.id);
    const nameMatch = producerNames.find(name => name === serviceKey || name.includes(serviceKey) || serviceKey.includes(name));
    if (!nameMatch && !service.endpoint) continue;

    const serviceRoute = normalizeRoute(service.endpoint || '/');
    const hasConcreteRoute = Boolean(service.endpoint) && serviceRoute !== '/';
    const candidateEntries = hasConcreteRoute
      ? producerEntries.filter(entryPoint => routesCompatible(serviceRoute, normalizeRoute(entryPoint.trigger?.path || entryPoint.name || '/')))
      : nameMatch ? representativeEntries(producerEntries) : [];

    for (const entryPoint of candidateEntries) {
      const entryRoute = normalizeRoute(entryPoint.trigger?.path || entryPoint.name || '/');
      const routeCompatible = hasConcreteRoute && routesCompatible(serviceRoute, entryRoute);

      const confidenceValue = nameMatch && routeCompatible ? 0.91 : nameMatch ? 0.82 : 0.76;
      links.push({
        id: crossRepoId('api', consumer.name, service.id, producer.name, entryPoint.id),
        type: 'api',
        source_repository: { path: consumer.path, node_ids: service.connected_nodes || [] },
        target_repository: { path: producer.path, node_ids: [entryPoint.source_node] },
        connection: {
          protocol: service.type?.includes('grpc') ? 'grpc' : service.endpoint?.includes('graphql') ? 'graphql' : service.type || 'http',
          endpoint: entryPoint.trigger?.path || service.endpoint,
          method: entryPoint.trigger?.method,
          contract: service.name,
        },
        metadata: {
          verified: confidenceValue >= 0.9,
          last_sync: new Date().toISOString(),
          confidence: confidenceValue,
          evidence: [
            { kind: 'graph', source: `${consumer.name}:${service.id}`, confidence: confidenceValue },
            { kind: 'route', source: `${producer.name}:${entryPoint.id}`, file: entryPoint.handler?.file, line: entryPoint.handler?.line, confidence: 0.88 },
          ],
        },
      });
    }
  }

  return links;
}

function detectEnvironmentContractLinks(
  consumer: { path: string; name: string; cas: CASOutput },
  producer: { path: string; name: string; cas: CASOutput }
): CASCrossRepositoryLink[] {
  const links: CASCrossRepositoryLink[] = [];
  const envs = consumer.cas.configuration?.environment_variables || [];
  const producerNames = producerServiceNames(producer);
  const entries = producer.cas.entry_points || [];

  for (const env of envs) {
    const envName = env.name.toLowerCase();
    const envValue = String(env.default || '').toLowerCase();
    const looksLikeEndpoint = /url|uri|endpoint|base|host|graphql|grpc|webhook/.test(envName) || /^https?:\/\//.test(envValue);
    if (!looksLikeEndpoint) continue;

    const serviceKey = normalizeServiceKey(envName.replace(/_(url|uri|endpoint|base|host|api|service)$/i, ''));
    const producerNameMatch = producerNames.some(name => serviceKey && (name.includes(serviceKey) || serviceKey.includes(name)));
    const valueRoute = normalizeRoute(envValue || '/');
    const hasConcreteRoute = Boolean(envValue) && valueRoute !== '/';
    const candidateEntries = hasConcreteRoute
      ? entries.filter(entryPoint => routesCompatible(valueRoute, normalizeRoute(entryPoint.trigger?.path || entryPoint.name || '/')))
      : producerNameMatch ? representativeEntries(entries) : [];

    for (const entryPoint of candidateEntries) {
      const entryRoute = normalizeRoute(entryPoint.trigger?.path || entryPoint.name || '/');
      const routeMatch = hasConcreteRoute && routesCompatible(valueRoute, entryRoute);

      const confidenceValue = producerNameMatch && routeMatch ? 0.89 : producerNameMatch ? 0.78 : 0.74;
      links.push({
        id: crossRepoId('api', consumer.name, `env-${env.name}`, producer.name, entryPoint.id),
        type: 'api',
        source_repository: { path: consumer.path, node_ids: env.used_by || [] },
        target_repository: { path: producer.path, node_ids: [entryPoint.source_node] },
        connection: {
          protocol: envName.includes('grpc') ? 'grpc' : envName.includes('graphql') ? 'graphql' : 'http',
          endpoint: entryPoint.trigger?.path || env.default,
          method: entryPoint.trigger?.method,
          contract: env.name,
        },
        metadata: {
          verified: false,
          last_sync: new Date().toISOString(),
          confidence: confidenceValue,
          evidence: [
            { kind: 'configuration', source: `${consumer.name}:${env.name}`, confidence: confidenceValue },
            { kind: 'route', source: `${producer.name}:${entryPoint.id}`, file: entryPoint.handler?.file, line: entryPoint.handler?.line, confidence: 0.86 },
          ],
        },
      });
    }
  }

  return links;
}

function detectSharedSchemaLinks(
  left: { path: string; name: string; cas: CASOutput },
  right: { path: string; name: string; cas: CASOutput },
  hasDirectContract: boolean
): CASCrossRepositoryLink[] {
  if (!hasDirectContract && repositoryAffinityScore(left, right) < 0.1) return [];
  const links: CASCrossRepositoryLink[] = [];
  const leftSchemas = schemaContracts(left.cas);
  const rightSchemas = schemaContracts(right.cas);

  for (const schema of leftSchemas) {
    const match = rightSchemas.find(candidate => candidate.key === schema.key);
    if (!match) continue;

    links.push({
      id: crossRepoId('shared-schema', left.name, schema.id, right.name, match.id),
      type: 'shared-schema',
      source_repository: { path: left.path, node_ids: schema.nodeIds },
      target_repository: { path: right.path, node_ids: match.nodeIds },
      connection: {
        contract: schema.name,
        protocol: schema.protocol,
      },
      metadata: {
        verified: schema.exact && match.exact,
        last_sync: new Date().toISOString(),
        confidence: schema.exact && match.exact ? 0.93 : 0.81,
        evidence: [
          { kind: schema.kind, source: `${left.name}:${schema.name}`, file: schema.file, confidence: schema.exact ? 0.92 : 0.8 },
          { kind: match.kind, source: `${right.name}:${match.name}`, file: match.file, confidence: match.exact ? 0.92 : 0.8 },
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
        verified: true,
        last_sync: new Date().toISOString(),
        confidence: 0.92,
        evidence: [
          { kind: 'graph', source: `${producer.name}:${exitPoint.id}`, confidence: 0.92 },
          { kind: 'graph', source: `${consumer.name}:${entryPoint.id}`, confidence: 0.92 },
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

function detectSharedEntityLinks(
  left: { path: string; name: string; cas: CASOutput },
  right: { path: string; name: string; cas: CASOutput },
  hasDirectContract: boolean
): CASCrossRepositoryLink[] {
  if (!hasDirectContract && repositoryAffinityScore(left, right) < 0.1) return [];
  const links: CASCrossRepositoryLink[] = [];
  const leftEntities = entityVocabulary(left.cas);
  const rightEntities = entityVocabulary(right.cas);
  const rightEntitiesByName = new Map(rightEntities.map(entity => [entity.name.toLowerCase(), entity]));
  const seen = new Set<string>();

  const addLink = (
    entityName: string,
    source: { path: string; name: string; cas: CASOutput },
    sourceNodeIds: string[],
    target: { path: string; name: string; cas: CASOutput },
    targetNodes: CASNode[],
    sourceEntity: EntityContractEvidence,
    targetEntity: EntityContractEvidence
  ) => {
    const key = entityName.toLowerCase();
    if (seen.has(key)) return;
    if (!entityShapesCompatible(sourceEntity, targetEntity)) return;
    seen.add(key);
    const confidenceValue = hasDirectContract ? 0.9 : 0.84;
    links.push({
      id: crossRepoId('shared-schema', source.name, `entity-${entityName}`, target.name, `entity-${entityName}`),
      type: 'shared-schema',
      source_repository: { path: source.path, node_ids: sourceNodeIds },
      target_repository: { path: target.path, node_ids: targetNodes.map(node => node.id) },
      connection: {
        contract: entityName,
        protocol: 'entity',
      },
      metadata: {
        verified: false,
        last_sync: new Date().toISOString(),
        confidence: confidenceValue,
        evidence: [
          { kind: 'naming', source: `${source.name}:${entityName}`, confidence: confidenceValue },
          {
            kind: 'naming',
            source: `${target.name}:${entityName}`,
            file: targetNodes[0]?.source?.file,
            line: targetNodes[0]?.source?.line,
            confidence: confidenceValue,
          },
        ],
      },
    });
  };

  for (const entity of leftEntities) {
    const targetEntity = rightEntitiesByName.get(entity.name.toLowerCase());
    if (!targetEntity) continue;
    const targetNodes = entityTypeNodes(right.cas, entity.name);
    if (targetNodes.length === 0) continue;
    addLink(entity.name, left, entity.nodeIds, right, targetNodes, entity, targetEntity);
  }

  for (const entity of rightEntities) {
    if (seen.has(entity.name.toLowerCase())) continue;
    const targetEntity = leftEntities.find(candidate => candidate.name.toLowerCase() === entity.name.toLowerCase());
    if (!targetEntity) continue;
    const targetNodes = entityTypeNodes(left.cas, entity.name);
    if (targetNodes.length === 0) continue;
    addLink(entity.name, right, entity.nodeIds, left, targetNodes, entity, targetEntity);
  }

  return links;
}

function qualifiedImportName(node: CASNode): string | undefined {
  const metadata = node.metadata as Record<string, any> | undefined;
  const candidates = [node.name, metadata?.source, metadata?.attributes?.source, node.qualified_name];
  for (const candidate of candidates) {
    const value = String(candidate || '');
    if (value.includes('\\') && value.split('\\').filter(Boolean).length >= 3) return value;
  }
  return undefined;
}

function detectNamespaceImportLinks(
  consumer: { path: string; name: string; cas: CASOutput },
  producer: { path: string; name: string; cas: CASOutput }
): CASCrossRepositoryLink[] {
  const links: CASCrossRepositoryLink[] = [];
  const importNodes = consumer.cas.nodes.filter(node => node.type === 'use' || node.type === 'import');
  if (importNodes.length === 0) return links;

  const producerClassesByName = new Map<string, CASNode[]>();
  for (const node of producer.cas.nodes) {
    if (node.type !== 'class' && node.type !== 'interface') continue;
    if (!node.source?.file) continue;
    const key = node.name.toLowerCase();
    producerClassesByName.set(key, [...(producerClassesByName.get(key) || []), node]);
  }
  if (producerClassesByName.size === 0) return links;

  const seen = new Set<string>();
  for (const importNode of importNodes) {
    const qualified = qualifiedImportName(importNode);
    if (!qualified) continue;
    const segments = qualified.split('\\').filter(Boolean);
    const className = segments[segments.length - 1];
    const parentSegment = segments[segments.length - 2];
    if (!className || !parentSegment) continue;
    if (seen.has(qualified.toLowerCase())) continue;

    const candidates = producerClassesByName.get(className.toLowerCase()) || [];
    const match = candidates.find(candidate => {
      const file = (candidate.source?.file || '').replace(/\\/g, '/');
      return file.toLowerCase().endsWith(`/${parentSegment.toLowerCase()}/${className.toLowerCase()}.php`);
    });
    if (!match) continue;
    seen.add(qualified.toLowerCase());

    links.push({
      id: crossRepoId('library', consumer.name, qualified, producer.name, match.id),
      type: 'library',
      source_repository: { path: consumer.path, node_ids: [importNode.id] },
      target_repository: { path: producer.path, node_ids: [match.id] },
      connection: {
        package_name: producer.name,
        contract: qualified,
      },
      metadata: {
        verified: false,
        last_sync: new Date().toISOString(),
        confidence: 0.85,
        evidence: [
          {
            kind: 'dependency',
            source: `${consumer.name}:${qualified}`,
            file: importNode.source?.file,
            line: importNode.source?.line,
            confidence: 0.85,
          },
          {
            kind: 'source-location',
            source: `${producer.name}:${match.name}`,
            file: match.source?.file,
            line: match.source?.line,
            confidence: 0.85,
          },
        ],
      },
    });
  }

  return links;
}

export interface CrossRepoJourney {
  id: string;
  consumer: {
    repository: string;
    action_files: string[];
    call_file?: string;
    call_symbol?: string;
    url?: string;
  };
  http: {
    method?: string;
    route?: string;
  };
  provider: {
    repository: string;
    route?: string;
    handler?: string;
    handler_file?: string;
    handler_line?: number;
    services: string[];
    terminal_entities: string[];
  };
  confidence: number;
}

export function buildCrossRepoJourneys(
  repositories: Array<{ path: string; name: string; cas: CASOutput }>,
  links: CASCrossRepositoryLink[],
  options: { limit?: number } = {}
): CrossRepoJourney[] {
  const limit = options.limit ?? 25;
  const byPath = new Map(repositories.map(repository => [repository.path, repository]));
  const journeys: CrossRepoJourney[] = [];

  const apiLinks = links
    .filter(link => link.type === 'api' && link.source_repository?.path && link.target_repository?.path)
    .sort((left, right) => {
      const routeOrder = String(left.connection?.endpoint || '').localeCompare(String(right.connection?.endpoint || ''));
      if (routeOrder !== 0) return routeOrder;
      return String(left.connection?.method || '').localeCompare(String(right.connection?.method || ''));
    });

  const seen = new Set<string>();
  for (const link of apiLinks) {
    const consumer = byPath.get(link.source_repository!.path!);
    const provider = byPath.get(link.target_repository!.path!);
    if (!consumer || !provider) continue;

    const consumerNodeId = link.source_repository?.node_ids?.[0];
    const consumerNode = consumerNodeId ? consumer.cas.nodes.find(node => node.id === consumerNodeId) : undefined;
    const providerEntry = (provider.cas.entry_points || []).find(entry =>
      (link.target_repository?.node_ids || []).includes(entry.source_node) &&
      normalizeRoute(entry.trigger?.path || entry.name) === normalizeRoute(String(link.connection?.endpoint || ''))
    ) || (provider.cas.entry_points || []).find(entry => (link.target_repository?.node_ids || []).includes(entry.source_node));
    if (!providerEntry) continue;

    const journeyKey = `${providerEntry.trigger?.method || ''} ${providerEntry.trigger?.path || providerEntry.name}:${consumerNode?.source?.file || consumerNodeId || ''}`;
    if (seen.has(journeyKey)) continue;
    seen.add(journeyKey);

    const handlerFile = providerEntry.handler?.file || provider.cas.nodes.find(node => node.id === providerEntry.handler?.node_id)?.source?.file;
    const handlerImports = handlerFile
      ? provider.cas.nodes.filter(node =>
        (node.type === 'use' || node.type === 'import') &&
        node.source?.file &&
        pathsCompatible(node.source.file, handlerFile)
      )
      : [];

    const serviceCandidates = [...new Set(handlerImports
      .map(node => qualifiedImportName(node) || node.name)
      .filter(name => name.includes('\\') && /\\service\\|\\manager\\/i.test(name))
      .map(name => name.split('\\').filter(Boolean).pop()!))]
      .sort();
    const strongServices = serviceCandidates.filter(name => /(service|manager|provider|handler)(interface)?$/i.test(name));
    const services = (strongServices.length > 0 ? strongServices : serviceCandidates).slice(0, 5);

    const entityNames = new Set((provider.cas.entities || []).map(entity => entity.name.toLowerCase()));
    const importedEntities = [...new Set(handlerImports
      .map(node => qualifiedImportName(node) || node.name)
      .filter(name => /\\entity\\|\\model\\/i.test(name))
      .map(name => name.split('\\').filter(Boolean).pop()!)
      .filter(name => entityNames.size === 0 || entityNames.has(name.toLowerCase())))]
      .sort();
    const terminalEntities = importedEntities.length > 0
      ? importedEntities.slice(0, 5)
      : routeResourceEntities(providerEntry.trigger?.path || '', provider.cas);

    const consumerFile = consumerNode?.source?.file;
    const actionFiles = consumerFile ? consumerActionFiles(consumer.cas, consumerFile) : [];
    const handlerOwner = provider.cas.nodes.find(node =>
      (node.type === 'controller' || node.type === 'class') &&
      node.source?.file &&
      handlerFile &&
      pathsCompatible(node.source.file, handlerFile)
    );
    const handlerLabel = providerEntry.handler?.method_name
      ? `${handlerOwner?.name || handlerFileBase(handlerFile)}::${providerEntry.handler.method_name}`
      : handlerOwner?.name;

    journeys.push({
      id: `journey:${normalizeTopic(`${providerEntry.trigger?.method || 'any'}-${providerEntry.trigger?.path || providerEntry.name}`)}`,
      consumer: {
        repository: consumer.name,
        action_files: actionFiles,
        call_file: consumerFile,
        call_symbol: consumerNode?.name,
        url: String(link.connection?.endpoint || ''),
      },
      http: {
        method: providerEntry.trigger?.method || link.connection?.method,
        route: providerEntry.trigger?.path || link.connection?.endpoint,
      },
      provider: {
        repository: provider.name,
        route: providerEntry.trigger?.path,
        handler: handlerLabel,
        handler_file: handlerFile,
        handler_line: providerEntry.handler?.line,
        services,
        terminal_entities: terminalEntities,
      },
      confidence: link.metadata?.confidence || 0,
    });

    if (journeys.length >= limit) break;
  }

  return journeys;
}

function handlerFileBase(file?: string): string | undefined {
  if (!file) return undefined;
  const base = file.split('/').pop() || file;
  return base.replace(/\.(php|ts|js|py|java|cs|go|rb)$/i, '');
}

function routeResourceEntities(routePath: string, cas: CASOutput): string[] {
  const entityByKey = new Map((cas.entities || []).map(entity => [entity.name.toLowerCase(), entity.name]));
  if (entityByKey.size === 0) return [];
  const segments = routePath.toLowerCase().split('/')
    .filter(segment => segment && !segment.startsWith(':') && !segment.startsWith('{') && !segment.startsWith('$'));

  const matches: string[] = [];
  for (const segment of segments.reverse()) {
    const candidates = [segment, segment.replace(/ies$/, 'y'), segment.replace(/es$/, ''), segment.replace(/s$/, ''), segment.replace(/-/g, '')];
    for (const candidate of candidates) {
      const match = entityByKey.get(candidate);
      if (match && !matches.includes(match)) {
        matches.push(match);
        break;
      }
    }
    if (matches.length > 0) break;
  }
  return matches;
}

function consumerActionFiles(cas: CASOutput, consumerFile: string): string[] {
  const base = (consumerFile.split('/').pop() || consumerFile).replace(/\.(ts|js|tsx|jsx)$/i, '');
  if (!base) return [];
  const files = new Set<string>();

  for (const node of cas.nodes) {
    if (node.type !== 'import') continue;
    const metadata = node.metadata as Record<string, any> | undefined;
    const specifier = String(metadata?.source || metadata?.attributes?.source || '');
    if (!specifier) continue;
    const specifierBase = specifier.split('/').pop() || specifier;
    if (specifierBase !== base) continue;
    const file = node.source?.file;
    if (!file || file === consumerFile) continue;
    if (isNonRuntimeSourceFile(file.toLowerCase())) continue;
    files.add(file);
  }

  return [...files].sort().slice(0, 5);
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

  const exitMatch = matchRuntimeExit(cas, event);
  if (exitMatch) matches.push(exitMatch);

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

export function buildOperationalPriorities(cas: CASOutput, observations: RuntimeObservation[], options: { limit?: number } = {}): {
  generated_at: string;
  observation_count: number;
  sources: { ingested: number; simulated: number };
  priorities: OperationalPriority[];
  guidance: string[];
} {
  const groups = new Map<string, RuntimeObservation[]>();
  for (const observation of observations) {
    const key = observation.correlation.best_match?.id
      || observation.event.static_id
      || observation.event.node_id
      || observation.event.entry_point_id
      || observation.event.route
      || observation.event.path
      || observation.event.signal
      || 'unmatched-runtime';
    const current = groups.get(key) || [];
    current.push(observation);
    groups.set(key, current);
  }

  const priorities = [...groups.entries()].map(([key, items]) => {
    const best = pickStaticTarget(cas, items);
    const stats = runtimeImpactStats(items);
    const { errors, slow_events: slowEvents, traces, estimated_volume: estimatedVolume } = stats;
    const staticRiskId = runtimeStaticTargetId(cas, best?.id) || best?.id || key;
    const healthRisk = matchingSystemHealthRisk(cas, staticRiskId);
    const changeRisk = matchingChangeRisk(cas, staticRiskId);
    const untested = Boolean(changeRisk && (cas.change_risk_summary?.untested_critical_paths || []).includes(staticRiskId));
    const staticWeight = healthRisk?.severity === 'critical' ? 35 :
      healthRisk?.severity === 'high' ? 25 :
      healthRisk?.severity === 'medium' ? 15 : 0;
    const score = Math.min(100, Math.round(
      errors * 18 +
      slowEvents * 8 +
      Math.log10(Math.max(1, estimatedVolume)) * 12 +
      (stats.rates.error_rate >= 0.05 ? 14 : stats.rates.error_rate >= 0.01 ? 8 : 0) +
      (Number(stats.latency.p99_ms || 0) >= 2000 ? 10 : Number(stats.latency.p95_ms || 0) >= 1000 ? 6 : 0) +
      traces * 3 +
      staticWeight +
      (untested ? 12 : 0)
    ));
    const severity: OperationalPriority['severity'] =
      score >= 85 || errors >= 5 ? 'critical' :
      score >= 60 || errors >= 2 ? 'high' :
      score >= 30 || slowEvents > 0 ? 'medium' : 'low';
    const itemSources = new Set(items.map(runtimeObservationSource));
    const source: OperationalPriority['source'] = itemSources.size > 1 ? 'mixed' : [...itemSources][0] || 'ingested';

    return {
      id: `priority_${normalizePriorityId(key)}`,
      title: best ? `${best.label} has runtime impact` : `${key} needs runtime triage`,
      priority_score: score,
      severity,
      source,
      static_target: best,
      runtime: {
        observations: items.length,
        errors,
        slow_events: slowEvents,
        estimated_volume: estimatedVolume,
        traces,
        latency: stats.latency,
        rates: stats.rates,
      },
      static_risk: {
        system_health_risk: healthRisk?.title,
        change_risk: changeRisk?.risk_level,
        untested,
      },
      recommendation: operationalRecommendation(errors, slowEvents, healthRisk?.type),
      agent_guidance: [
        'Use get_runtime_trace for representative traces before editing.',
        'Use get_agent_context with static_target.file (preferred) or static_target.id as the target so fixes preserve local idioms and behavior.',
        'Use assess_change_risk, find_tests, validate_behavioral_invariants, and validate_codebase_idioms before finalizing.',
      ],
    } satisfies OperationalPriority;
  });

  priorities.sort((left, right) => right.priority_score - left.priority_score);
  return {
    generated_at: new Date().toISOString(),
    observation_count: observations.length,
    sources: {
      ingested: observations.filter(observation => runtimeObservationSource(observation) === 'ingested').length,
      simulated: observations.filter(observation => runtimeObservationSource(observation) === 'simulated').length,
    },
    priorities: priorities.slice(0, options.limit || 20),
    guidance: [
      'Prioritize issues where runtime volume or errors overlap static criticality, missing tests, complexity, or idiom drift.',
      'Use Klauro runtime correlation as a triage map; source edits still need the normal CAS agent context and validation loop.',
    ],
  };
}

export function runtimeImpactStats(items: RuntimeObservation[]): RuntimeImpactStats {
  const durations = items
    .map(item => Number(item.event.duration_ms || item.event.attributes?.duration_ms || 0))
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  const errors = items.filter(item =>
    item.event.type === 'error' ||
    Number(item.event.status_code || 0) >= 500 ||
    Boolean(item.event.error_message)
  ).length;
  const slowEvents = items.filter(item => {
    const p95 = Number(item.event.attributes?.p95_ms || 0);
    const p99 = Number(item.event.attributes?.p99_ms || 0);
    const duration = Number(item.event.duration_ms || 0);
    return p99 >= 2000 || p95 >= 1000 || duration >= 1000;
  }).length;
  const volumeOf = (item: RuntimeObservation): number =>
    Math.max(1, Number(item.event.attributes?.volume || item.event.attributes?.count || 1));
  const isErrorItem = (item: RuntimeObservation): boolean =>
    item.event.type === 'error' || Number(item.event.status_code || 0) >= 500 || Boolean(item.event.error_message);
  const estimatedVolume = items.reduce((total, item) => total + volumeOf(item), 0);
  const traces = new Set(items.map(item => item.event.trace_id).filter(Boolean)).size;
  const errorVolume = items.reduce((total, item) => total + (isErrorItem(item) ? volumeOf(item) : 0), 0);

  let lastSeen: string | undefined;
  for (const item of items) {
    const ts = item.event.timestamp || item.recorded_at;
    if (ts && (!lastSeen || ts > lastSeen)) lastSeen = ts;
  }

  const statusDistribution: Record<string, number> = {};
  for (const item of items) {
    const code = item.event.status_code;
    if (typeof code === 'number' && Number.isFinite(code)) {
      const key = String(code);
      statusDistribution[key] = (statusDistribution[key] || 0) + volumeOf(item);
    }
  }
  const explicitThroughput = items
    .map(item => Number(item.event.attributes?.rate_per_min || item.event.attributes?.throughput_per_min || 0))
    .filter(value => Number.isFinite(value) && value > 0);
  const latency: RuntimeImpactStats['latency'] = {};
  if (durations.length > 0) {
    latency.avg_ms = Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length);
    latency.max_ms = durations[durations.length - 1];
    latency.p50_ms = percentile(durations, 0.5);
    latency.p95_ms = percentile(durations, 0.95);
    latency.p99_ms = percentile(durations, 0.99);
  }
  const explicitP95 = maxAttribute(items, 'p95_ms');
  const explicitP99 = maxAttribute(items, 'p99_ms');
  if (explicitP95) latency.p95_ms = Math.max(latency.p95_ms || 0, explicitP95);
  if (explicitP99) latency.p99_ms = Math.max(latency.p99_ms || 0, explicitP99);
  return {
    observations: items.length,
    request_count: estimatedVolume,
    errors,
    error_count: errorVolume,
    slow_events: slowEvents,
    estimated_volume: estimatedVolume,
    traces,
    last_seen: lastSeen,
    status_code_distribution: statusDistribution,
    latency,
    rates: {
      error_rate: estimatedVolume > 0 ? Math.round((errorVolume / estimatedVolume) * 10000) / 10000 : 0,
      ...(explicitThroughput.length > 0 ? { throughput_per_min: Math.round(explicitThroughput.reduce((sum, value) => sum + value, 0)) } : {}),
    },
  };
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * p) - 1));
  return sortedValues[index];
}

export function buildNodeRuntimeMetrics(
  cas: CASOutput,
  observations: RuntimeObservation[],
  options: { limit?: number } = {},
): NodeRuntimeMetrics[] {
  const groups = new Map<string, RuntimeObservation[]>();
  for (const observation of observations) {
    const key = observation.correlation.best_match?.id
      || observation.event.static_id
      || observation.event.entry_point_id
      || observation.event.node_id
      || (observation.event.method && (observation.event.route || observation.event.path)
        ? `${observation.event.method.toUpperCase()} ${observation.event.route || observation.event.path}`
        : undefined)
      || observation.event.route
      || observation.event.path
      || observation.event.signal
      || 'unmatched-runtime';
    const current = groups.get(key) || [];
    current.push(observation);
    groups.set(key, current);
  }

  const metrics: NodeRuntimeMetrics[] = [...groups.entries()].map(([key, items]) => {
    const target = pickStaticTarget(cas, items);
    const stats = runtimeImpactStats(items);
    const representative = items.find(item => item.event.route || item.event.path) || items[0];
    const sources = new Set(items.map(runtimeObservationSource));
    const source: NodeRuntimeMetrics['source'] = sources.size > 1 ? 'mixed' : [...sources][0] || 'ingested';
    return {
      static_id: target?.id || key,
      node_id: representative.event.node_id,
      entry_point_id: representative.event.entry_point_id,
      label: target?.label || key,
      type: target?.type || 'unmatched',
      file: target?.file,
      route: representative.event.route || representative.event.path,
      method: representative.event.method,
      request_count: stats.request_count,
      ...(stats.rates.throughput_per_min !== undefined ? { throughput_per_min: stats.rates.throughput_per_min } : {}),
      error_count: stats.error_count,
      error_rate: stats.rates.error_rate,
      status_code_distribution: stats.status_code_distribution,
      latency: stats.latency,
      slow_events: stats.slow_events,
      observations: stats.observations,
      traces: stats.traces,
      last_seen: stats.last_seen,
      source,
    } satisfies NodeRuntimeMetrics;
  });

  metrics.sort((left, right) =>
    right.error_count - left.error_count ||
    right.request_count - left.request_count ||
    Number(right.latency.p95_ms || 0) - Number(left.latency.p95_ms || 0));

  return options.limit && options.limit > 0 ? metrics.slice(0, options.limit) : metrics;
}

function maxAttribute(items: RuntimeObservation[], name: string): number {
  return Math.max(0, ...items.map(item => Number(item.event.attributes?.[name] || 0)).filter(value => Number.isFinite(value)));
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

function matchingSystemHealthRisk(cas: CASOutput, staticId: string) {
  return (cas.system_health?.risk_areas || []).find(area =>
    area.affected_nodes?.includes(staticId) ||
    area.affected_files?.some(file => staticId.includes(file) || file.includes(staticId)) ||
    area.id === staticId
  );
}

function matchingChangeRisk(cas: CASOutput, staticId: string) {
  return (cas.change_risks || []).find(risk => risk.node_id === staticId);
}

function pickStaticTarget(cas: CASOutput, items: RuntimeObservation[]): EvidenceRef | undefined {
  for (const item of items) {
    const best = item.correlation.best_match;
    if (!best) continue;
    if (best.file) return best;
    const withFile = item.correlation.matches.find(match => match.file);
    if (withFile) return withFile;
    const staticId = runtimeStaticTargetId(cas, best.id);
    const resolved = staticId ? staticRefForId(cas, staticId) : undefined;
    return resolved || best;
  }
  return undefined;
}

function runtimeStaticTargetId(cas: CASOutput, runtimeLinkId?: string): string | undefined {
  if (!runtimeLinkId) return undefined;
  return (cas.runtime_static_links || []).find(link => link.id === runtimeLinkId)?.static_id;
}

function operationalRecommendation(errors: number, slowEvents: number, riskType?: string): string {
  if (errors > 0 && riskType) return `Fix the runtime error path while addressing static ${riskType} risk.`;
  if (errors > 0) return 'Fix the highest-volume runtime errors first and add regression coverage around the matched CAS target.';
  if (slowEvents > 0) return 'Investigate latency bottlenecks on the matched flow and verify the static call chain before optimizing.';
  return 'Review the matched static risk and add telemetry or tests if impact remains uncertain.';
}

function normalizePriorityId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase().slice(0, 80) || 'runtime';
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

function matchRuntimeExit(cas: CASOutput, event: RuntimeEventInput): EvidenceRef | undefined {
  if (event.type !== 'exit') return undefined;
  const endpoint = normalizeRoute(event.endpoint || event.target || event.route || event.path || '');
  if (!endpoint) return undefined;
  const method = event.method?.toUpperCase();
  const exit = (cas.exit_points || []).find(candidate => {
    const candidateEndpoint = normalizeRoute(
      (candidate.target as any)?.endpoint || (candidate.metadata as any)?.endpoint || candidate.name || ''
    );
    const candidateMethod = (candidate.operation as any)?.method?.toUpperCase();
    const methodMatches = !method || !candidateMethod || candidateMethod === method;
    return methodMatches && candidateEndpoint && routesCompatible(endpoint, candidateEndpoint);
  });
  return exit ? exitPointEvidence([exit])[0] : undefined;
}

function matchStackFrames(cas: CASOutput, stack?: string): EvidenceRef[] {
  if (!stack) return [];
  const fileMatches = [...stack.matchAll(/(?:at\s+.*\()?([/\w.-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|cs|php)):(\d+):\d+\)?/g)];
  const refs: EvidenceRef[] = [];
  for (const match of fileMatches.slice(0, 5)) {
    const file = match[1];
    const line = Number(match[2]);

    const enclosing = cas.nodes
      .filter(candidate =>
        candidate.source?.file &&
        pathsCompatible(candidate.source.file, file) &&
        candidate.source.line && candidate.source.end_line &&
        candidate.source.line <= line && candidate.source.end_line >= line)
      .sort((a, b) => {
        const symbolic = (n: any) => /function|method|constructor|class/.test(String(n.type)) ? 0 : 1;
        const bySymbol = symbolic(a) - symbolic(b);
        if (bySymbol !== 0) return bySymbol;
        return (a.source!.end_line! - a.source!.line!) - (b.source!.end_line! - b.source!.line!);
      });
    const node = enclosing[0]
      || cas.nodes.find(candidate => candidate.source?.file && pathsCompatible(candidate.source.file, file));

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
    label: runtimeLinkOwnerLabel(link),
    file: String((link as any).evidence?.[0]?.file || '') || undefined,
    confidence: link.confidence,
  };
}

function runtimeLinkOwnerLabel(link: CASRuntimeStaticLink): string {
  const signal = link.runtime_signal || link.id;
  const file = String((link as any).evidence?.[0]?.file || '').replace(/\\/g, '/');
  const segments = file
    .split('/')
    .filter(segment => segment && !/^(src|app|apps|lib|libs|packages|node_modules|dist|build)$/i.test(segment))
    .map(segment => segment.replace(/\.[^.]+$/, ''))
    .filter(Boolean);
  const owner = segments.slice(-2).join('/');
  if (owner && owner.toLowerCase() !== signal.toLowerCase()) {
    return `${signal} in ${owner}`;
  }
  return signal;
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

  for (const exitPoint of cas.exit_points || []) {
    if (exitPoint.type !== 'database') continue;
    const identity = databaseEndpointIdentity(exitPoint.target?.endpoint || exitPoint.target?.resource);
    if (!identity) continue;
    resources.push({ id: exitPoint.id, key: identity, name: identity, nodeId: exitPoint.source_node });
  }

  return dedupeBy(resources, resource => resource.key);
}

function databaseEndpointIdentity(value: string | undefined): string | undefined {
  const raw = String(value || '').trim();
  if (!raw.includes('://') || /\$\{|<[^>]+>/.test(raw)) return undefined;
  try {
    const parsed = new URL(raw);
    if (!parsed.hostname || /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i.test(parsed.hostname)) return undefined;
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}${pathname}`;
  } catch {
    return undefined;
  }
}

function producerServiceNames(repository: { name: string; cas: CASOutput }): string[] {
  return [
    repository.name,
    repository.cas.system.name,
    ...(repository.cas.external_services || []).map(service => service.name),
    ...(repository.cas.libraries || []).map(library => library.name),
  ]
    .map(normalizeServiceKey)
    .filter(Boolean);
}

function representativeEntries(entries: CASEntryPoint[]): CASEntryPoint[] {
  return entries
    .filter(entry => entry.type === 'http' || entry.type === 'route' || entry.type === 'message' || entry.type === 'event')
    .slice(0, 3);
}

function schemaContracts(cas: CASOutput): Array<{
  id: string;
  key: string;
  name: string;
  protocol?: string;
  nodeIds?: string[];
  file?: string;
  exact: boolean;
  kind: 'configuration' | 'dependency' | 'graph';
}> {
  const schemas = [];

  for (const file of cas.configuration?.config_files || []) {
    const filePath = file.path || '';
    const lower = filePath.toLowerCase();
    if (!isSchemaLike(lower)) continue;
    schemas.push({
      id: `config:${filePath}`,
      key: normalizeSchemaKey(filePath),
      name: filePath,
      protocol: protocolForSchema(lower),
      file: filePath,
      exact: true,
      kind: 'configuration' as const,
    });
  }

  for (const library of cas.libraries || []) {
    const lower = library.name.toLowerCase();
    if (!isSchemaLike(lower) && !lower.includes('graphql') && !lower.includes('grpc')) continue;
    schemas.push({
      id: `library:${library.name}`,
      key: normalizeSchemaKey(library.name),
      name: library.name,
      protocol: protocolForSchema(lower),
      nodeIds: library.connected_nodes,
      exact: lower.includes('proto') || lower.includes('openapi') || lower.includes('graphql') || lower.includes('schema'),
      kind: 'dependency' as const,
    });
  }

  for (const entryPoint of cas.entry_points || []) {
    const operation = String(entryPoint.metadata?.graphql_operation || entryPoint.input?.schema || entryPoint.output?.schema || '');
    if (!operation) continue;
    const isGraphql = Boolean(entryPoint.metadata?.graphql_operation_type) || operation.toLowerCase().includes('graphql');
    if (!isGraphql) continue;
    schemas.push({
      id: `entry:${entryPoint.id}`,
      key: normalizeSchemaKey(operation || entryPoint.name),
      name: operation || entryPoint.name,
      protocol: 'graphql',
      nodeIds: [entryPoint.source_node],
      file: entryPoint.handler?.file,
      exact: Boolean(entryPoint.metadata?.graphql_operation),
      kind: 'graph' as const,
    });
  }

  for (const exitPoint of cas.exit_points || []) {
    const contract = exitPoint.data?.output_type || exitPoint.target?.resource || exitPoint.target?.endpoint || '';
    const lower = String(contract).toLowerCase();
    if (!isSchemaLike(lower) && !lower.includes('graphql') && !lower.includes('proto')) continue;
    schemas.push({
      id: `exit:${exitPoint.id}`,
      key: normalizeSchemaKey(contract),
      name: contract,
      protocol: protocolForSchema(lower),
      nodeIds: [exitPoint.source_node],
      exact: lower.includes('schema') || lower.includes('proto') || lower.includes('graphql'),
      kind: 'graph' as const,
    });
  }

  return dedupeBy(schemas, schema => schema.key);
}

function internalLibraries(cas: CASOutput): Array<{ name: string; version?: string }> {
  return (cas.libraries || [])
    .filter(library => {
      const name = library.name.toLowerCase();

      const selfToken = String(cas.system?.name || '').toLowerCase().replace(/[^a-z0-9].*$/, '');
      return name.startsWith('@') || (selfToken.length >= 4 && name.includes(selfToken));
    })
    .map(library => ({ name: library.name, version: library.version }));
}

function isSchemaLike(value: string): boolean {
  return value.includes('openapi') ||
    value.includes('swagger') ||
    value.includes('graphql') ||
    value.includes('schema') ||
    value.includes('proto') ||
    value.includes('grpc') ||
    value.endsWith('.proto') ||
    value.endsWith('.graphql') ||
    value.endsWith('.gql') ||
    value.endsWith('openapi.json') ||
    value.endsWith('openapi.yaml') ||
    value.endsWith('swagger.json') ||
    value.endsWith('swagger.yaml');
}

function protocolForSchema(value: string): string | undefined {
  if (value.includes('graphql') || value.endsWith('.gql')) return 'graphql';
  if (value.includes('proto') || value.includes('grpc')) return 'grpc';
  if (value.includes('openapi') || value.includes('swagger')) return 'http';
  return undefined;
}

function normalizeSchemaKey(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/^.*\/([^/]+)$/, '$1')
    .replace(/\.(json|yaml|yml|proto|graphql|gql|ts|js|py)$/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || normalizeTopic(value);
}

function normalizeServiceKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[:/?#].*$/, '')
    .replace(/\.(local|localhost|com|io|dev|net|org)$/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function looksLikeHttpPath(value: string): boolean {
  if (!value) return false;
  if (/\s/.test(value.trim().replace(/\$\{[^}]*\}/g, ':param'))) return false;
  return value.includes('/');
}

function normalizeRoute(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/\?.*$/, '')
    .replace(/\$\{[^}]*\}/g, ':param')
    .replace(/:[a-z0-9_]+/g, ':param')
    .replace(/\{[^}]+\}/g, ':param')
    .replace(/(^|\/)\*+(?=\/|$)/g, '$1:param')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
}

function routesCompatible(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.includes(':param') || right.includes(':param')) {
    const leftParts = routeSegments(left);
    const rightParts = routeSegments(right);
    if (leftParts.length === rightParts.length) {
      const compatible = leftParts.every((part, index) => part === rightParts[index] || part === ':param' || rightParts[index] === ':param');
      const sharedLiteral = leftParts.some((part, index) => part !== ':param' && part === rightParts[index]);
      return compatible && sharedLiteral;
    }
    return parameterizedSuffixMatch(leftParts, rightParts) || parameterizedSuffixMatch(rightParts, leftParts);
  }
  return left.endsWith(right) || right.endsWith(left);
}

function routeSegments(route: string): string[] {
  return route.split('/').filter(Boolean);
}

function parameterizedSuffixMatch(shorterParts: string[], longerParts: string[]): boolean {
  if (shorterParts.length === 0 || shorterParts.length >= longerParts.length) return false;
  const tail = longerParts.slice(longerParts.length - shorterParts.length);
  const compatible = shorterParts.every((part, index) => part === tail[index] || part === ':param' || tail[index] === ':param');
  const sharedLiteral = shorterParts.some((part, index) => part !== ':param' && part === tail[index]);
  return compatible && sharedLiteral;
}

function routeMatchScore(left: string, right: string): number {
  if (left === right) return 0.98;
  const leftParts = routeSegments(left);
  const rightParts = routeSegments(right);
  if (leftParts.length === 0 && rightParts.length === 0) return 0.98;
  if (leftParts.length === rightParts.length) {
    const matches = leftParts.filter((part, index) =>
      part === rightParts[index] || part === ':param' || rightParts[index] === ':param'
    ).length;
    return Math.max(0.65, Math.round((matches / leftParts.length) * 100) / 100);
  }
  if (parameterizedSuffixMatch(leftParts, rightParts) || parameterizedSuffixMatch(rightParts, leftParts)) {
    const wildcardParts = leftParts.length < rightParts.length ? leftParts : rightParts;
    const literalSuffix = wildcardParts.filter(part => part !== ':param').length;
    return literalSuffix >= 2 ? 0.82 : 0.74;
  }
  if (left.endsWith(right) || right.endsWith(left)) return 0.78;
  return 0.55;
}

function normalizeHttpMethod(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.toUpperCase();
  if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ALL', 'FETCH'].includes(normalized)) return normalized;
  return normalized;
}

function certaintyBand(confidenceValue: number): 'confirmed' | 'likely' | 'possible' {
  if (confidenceValue >= 0.9) return 'confirmed';
  if (confidenceValue >= 0.75) return 'likely';
  return 'possible';
}

function findCrossRepoLinkConflicts(links: CASCrossRepositoryLink[]): Array<{ id: string; link_ids: string[]; reason: string }> {
  const byConsumerContract = new Map<string, CASCrossRepositoryLink[]>();

  for (const link of links) {
    if (link.type !== 'api' && link.type !== 'message-contract') continue;
    const endpoint = link.connection?.endpoint || link.connection?.routing_key;
    const method = link.connection?.method || '*';
    const source = link.source_repository?.path || 'unknown';
    if (!endpoint) continue;
    const key = `${link.type}:${source}:${method}:${normalizeRoute(endpoint)}`;
    byConsumerContract.set(key, [...(byConsumerContract.get(key) || []), link]);
  }

  return [...byConsumerContract.entries()]
    .map(([key, candidates]) => {
      const maxConfidence = Math.max(...candidates.map(link => link.metadata?.confidence || 0));
      const competing = candidates.filter(link => (link.metadata?.confidence || 0) >= maxConfidence - 0.05);
      return [key, competing] as const;
    })
    .filter(([, candidates]) => hasMultipleIndependentTargets(candidates))
    .map(([key, candidates]) => ({
      id: `conflict:${normalizeTopic(key)}`,
      link_ids: candidates.map(link => link.id),
      reason: 'One consumed contract maps to multiple target repositories with compatible certainty.',
    }));
}

function hasMultipleIndependentTargets(candidates: CASCrossRepositoryLink[]): boolean {
  const paths = [...new Set(candidates.map(link => link.target_repository?.path || '').filter(Boolean))]
    .map(normalizeRepoPathForComparison);
  if (paths.length <= 1) return false;
  const independentRoots = paths.filter(candidate =>
    !paths.some(other => other !== candidate && isNestedRepoPath(candidate, other))
  );
  return independentRoots.length > 1;
}

function normalizeRepoPathForComparison(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '');
}

function isNestedRepoPath(candidate: string, other: string): boolean {
  return candidate.startsWith(`${other}/`) || other.startsWith(`${candidate}/`);
}

function normalizeTopic(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalizeSignal(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9:./_-]+/g, '');
}

export function pathsCompatible(left: string, right: string): boolean {
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
