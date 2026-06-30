import { isDirectCliInvocation } from './cli-invocation';
import * as fs from 'fs-extra';
import * as path from 'path';
import { analyzeForBench } from './gauntlet/product-analysis';
import { discoverTargets, type RepoTarget } from './gauntlet';
import type { CASOutput, CASNode } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  assessChangeRisk,
  buildSummary,
  findTests,
  getCallChain,
  getCallees,
  getCallers,
  getCodingContext,
  getDataEntities,
  getEntryPoints,
  getExitPoints,
  getExternalServices,
  getFlowCoverage,
  getSecurityOverview,
  getSystemOverview,
  searchNodes,
} from './query';

type GateStatus = 'pass' | 'warn' | 'fail';
type EvidenceType = 'node' | 'edge' | 'entry_point' | 'exit_point' | 'call_chain' | 'fact' | 'test' | 'data_entity' | 'summary';

interface EvidenceRef {
  type: EvidenceType;
  id: string;
  label: string;
  file?: string;
  line?: number;
}

interface AnswerProbe {
  id: string;
  question: string;
  status: GateStatus;
  score: number;
  answer: Record<string, unknown>;
  evidence: EvidenceRef[];
  checks: string[];
  gaps: string[];
}

interface TargetAnswerReport {
  name: string;
  path: string;
  status: GateStatus;
  score: number;
  durationMs: number;
  summary: {
    nodes: number;
    edges: number;
    entryPoints: number;
    exitPoints: number;
    methodCalls: number;
    callChains: number;
    facts: number;
    analysisErrors: number;
  };
  probes: AnswerProbe[];
  topGaps: string[];
}

interface AnswerGauntletReport {
  generatedAt: string;
  status: GateStatus;
  score: number;
  targets: TargetAnswerReport[];
}

function parseArgs(argv: string[]) {
  const repos: RepoTarget[] = [];
  let devRoot = path.join(process.env.HOME || '', 'dev');
  let outputPath = path.join(process.cwd(), '.klauro-answer-gauntlet', 'latest-report.json');
  let failOnWarn = false;
  let dryRun = false;
  let maxTargets: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') {
      const value = argv[++i];
      if (!value) throw new Error('--repo requires a path or name=path value');
      const [namePart, repoPathPart] = value.includes('=') ? value.split('=') : [undefined, value];
      const repoPath = path.resolve(repoPathPart);
      repos.push({
        name: namePart || path.basename(repoPath),
        path: repoPath,
        expectation: {},
      });
    } else if (arg === '--dev-root') {
      devRoot = path.resolve(argv[++i]);
    } else if (arg === '--output') {
      outputPath = path.resolve(argv[++i]);
    } else if (arg === '--fail-on-warn') {
      failOnWarn = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--max-targets') {
      maxTargets = Number(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { repos, devRoot, outputPath, failOnWarn, dryRun, maxTargets };
}

function printHelp(): void {
  console.log([
    'Usage: npm run answer-gauntlet -- [options]',
    '',
    'Options:',
    '  --repo name=/path/to/repo   Run a specific repo. May be repeated.',
    '  --repo /path/to/repo        Run a specific repo using folder name.',
    '  --dev-root /path           Root used for default repo discovery.',
    '  --output /path/report.json  Write JSON report.',
    '  --max-targets n            Limit discovered targets.',
    '  --dry-run                  Print selected targets without analysis.',
    '  --fail-on-warn             Exit nonzero for warnings as well as failures.',
  ].join('\n'));
}

function nodeEvidence(node: CASNode): EvidenceRef {
  return {
    type: 'node',
    id: node.id,
    label: `${node.type}:${node.name}`,
    file: node.source?.file,
    line: node.source?.line,
  };
}

function statusFromScore(score: number): GateStatus {
  if (score >= 85) return 'pass';
  if (score >= 60) return 'warn';
  return 'fail';
}

function probe(
  id: string,
  question: string,
  answer: Record<string, unknown>,
  evidence: EvidenceRef[],
  checks: string[],
  gaps: string[] = []
): AnswerProbe {
  const baseScore = Math.round((checks.length / Math.max(1, checks.length + gaps.length)) * 100);
  const evidenceScore = evidence.length > 0 ? 100 : 50;
  const score = Math.round((baseScore * 0.7) + (evidenceScore * 0.3));
  return {
    id,
    question,
    status: statusFromScore(score),
    score,
    answer,
    evidence,
    checks,
    gaps,
  };
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

function evidenceForIds(cas: CASOutput, ids: string[], type: EvidenceType, limit = 5): EvidenceRef[] {
  const evidence: EvidenceRef[] = [];
  for (const id of ids.slice(0, limit)) {
    const node = cas.nodes.find(candidate => candidate.id === id);
    if (node) {
      evidence.push(nodeEvidence(node));
      continue;
    }
    const entryPoint = (cas.entry_points || []).find(candidate => candidate.id === id);
    if (entryPoint) {
      evidence.push({ type: 'entry_point', id, label: entryPoint.name, file: entryPoint.handler?.file });
      continue;
    }
    const exitPoint = (cas.exit_points || []).find(candidate => candidate.id === id);
    if (exitPoint) {
      evidence.push({ type: 'exit_point', id, label: exitPoint.name });
      continue;
    }
    const chain = (cas.call_chains || []).find(candidate => candidate.id === id);
    if (chain) {
      evidence.push({ type: 'call_chain', id, label: chain.chain_type });
      continue;
    }
    const dataEntity = (cas.data_entities || []).find(candidate => candidate.id === id);
    if (dataEntity) {
      evidence.push({ type: 'data_entity', id, label: dataEntity.name });
      continue;
    }
    evidence.push({ type, id, label: id });
  }
  return evidence;
}

function overviewProbe(cas: CASOutput): AnswerProbe {
  const summary = buildSummary(cas);
  const overview = getSystemOverview(cas);
  const checks: string[] = [];
  const gaps: string[] = [];
  const evidence: EvidenceRef[] = [];

  if (summary.nodes > 0) checks.push(`CAS has ${summary.nodes} nodes`);
  else gaps.push('No nodes available');

  if (summary.edges > 0) checks.push(`CAS has ${summary.edges} edges`);
  else gaps.push('No edges available');

  if (summary.languages.length > 0) checks.push(`Detected languages: ${summary.languages.join(', ')}`);
  else gaps.push('No languages detected');

  if (summary.frameworks.length > 0) checks.push(`Detected frameworks: ${summary.frameworks.join(', ')}`);
  else checks.push('No framework required for this repository');

  evidence.push(
    ...cas.nodes.slice(0, 5).map(nodeEvidence),
    ...evidenceForIds(cas, (cas.analysis_facts || []).slice(0, 3).map(fact => fact.id), 'fact')
  );

  return probe(
    'overview',
    'What is this codebase and what technologies does it use?',
    {
      name: overview.name,
      type: overview.type,
      languages: summary.languages,
      frameworks: summary.frameworks,
      description: overview.enhanced_system_purpose?.inferred_description || overview.description,
      nodes: summary.nodes,
      edges: summary.edges,
    },
    evidence,
    checks,
    gaps
  );
}

function entryPointProbe(cas: CASOutput): AnswerProbe {
  const result = getEntryPoints(cas, { limit: 10 });
  const evidence = evidenceForIds(cas, result.entry_points.map(entry => entry.id), 'entry_point');
  const checks = result.total > 0
    ? [`Found ${result.total} entry points`, `Returned ${result.entry_points.length} entry point examples`]
    : [];
  const gaps = result.total > 0 ? [] : ['No entry points found'];

  return probe(
    'entry-points',
    'What are the main ways execution enters this system?',
    {
      total: result.total,
      examples: result.entry_points.map(entry => ({
        id: entry.id,
        name: entry.name,
        type: entry.type,
        source_node: entry.source_node,
        handler: entry.handler,
      })),
    },
    evidence,
    checks,
    gaps
  );
}

function flowProbe(cas: CASOutput): AnswerProbe {
  const entryPoint = (cas.entry_points || []).find(entry =>
    (cas.call_chains || []).some(chain => chain.entry_point.entry_point_id === entry.id)
  ) || (cas.entry_points || [])[0];
  const checks: string[] = [];
  const gaps: string[] = [];

  if (!entryPoint) {
    return probe(
      'flow',
      'What happens after a representative entry point is invoked?',
      { error: 'No entry point available' },
      [],
      [],
      ['No entry point available']
    );
  }

  const chainResult = getCallChain(cas, { entryPointId: entryPoint.id }) as { total: number; chains: any[] };
  const chain = chainResult.chains[0];
  if (chain) checks.push(`Found call chain for ${entryPoint.name}`);
  else gaps.push(`No call chain for ${entryPoint.name}`);

  const nodeIds = chain?.call_path?.map((step: any) => step.node_id).filter(Boolean) || [entryPoint.source_node];
  const evidence = [
    { type: 'entry_point' as const, id: entryPoint.id, label: entryPoint.name, file: entryPoint.handler?.file },
    ...evidenceForIds(cas, nodeIds, 'node'),
    ...(chain ? [{ type: 'call_chain' as const, id: chain.id, label: chain.chain_type }] : []),
  ];

  if (nodeIds.length > 0) checks.push(`Flow includes ${nodeIds.length} nodes`);
  else gaps.push('Flow has no node path');

  return probe(
    'flow',
    'What happens after a representative entry point is invoked?',
    {
      entry_point: {
        id: entryPoint.id,
        name: entryPoint.name,
        type: entryPoint.type,
      },
      chain,
    },
    evidence,
    checks,
    gaps
  );
}

function impactProbe(cas: CASOutput): AnswerProbe {
  const target = findMostConnectedNode(cas);
  if (!target) {
    return probe(
      'change-impact',
      'What would be affected if a central code element changed?',
      { error: 'No target node found' },
      [],
      [],
      ['No target node found']
    );
  }

  const callers = getCallers(cas, target.id, 2, 10);
  const callees = getCallees(cas, target.id, 2, 10);
  const risk = assessChangeRisk(cas, target.id);
  const context = getCodingContext(cas, target.id, { include: ['tests'] });
  const checks = [`Selected connected node ${target.name}`];
  const gaps: string[] = [];

  if (callers.total > 0 || callees.total > 0) checks.push(`Found ${callers.total} callers and ${callees.total} callees`);
  else gaps.push('No callers or callees found for selected node');

  if (!('error' in context)) checks.push('Coding context resolved');
  else gaps.push('Coding context did not resolve');

  return probe(
    'change-impact',
    'What would be affected if a central code element changed?',
    {
      target: {
        id: target.id,
        name: target.name,
        type: target.type,
        file: target.source?.file,
      },
      callers,
      callees,
      risk,
      context,
    },
    [
      nodeEvidence(target),
      ...evidenceForIds(cas, callers.callers.map(caller => caller.node_id), 'node'),
      ...evidenceForIds(cas, callees.callees.map(callee => callee.node_id), 'node'),
    ],
    checks,
    gaps
  );
}

function dataProbe(cas: CASOutput): AnswerProbe {
  const data = getDataEntities(cas, { limit: 10 });
  const dbSchema = cas.database_schema;
  const databaseExits = getExitPoints(cas, { type: 'database', limit: 10 });
  const checks: string[] = [];
  const gaps: string[] = [];

  if (data.total > 0) checks.push(`Found ${data.total} data entities`);
  if (dbSchema?.entities?.length) checks.push(`Found ${dbSchema.entities.length} database schema entities`);
  if (databaseExits.total > 0) checks.push(`Found ${databaseExits.total} database exit points`);
  if (checks.length === 0) checks.push('CAS reports no data entities, database schema, or database exits for this repository');

  const entityNodeIds = data.entities
    .map(entity => entity.id)
    .filter(Boolean);

  return probe(
    'data-model',
    'What data does this system read or write?',
    {
      data_entities: data,
      database_schema: dbSchema ? {
        entity_count: dbSchema.entities?.length || 0,
        relationship_count: dbSchema.entities?.reduce((count, entity) => count + (entity.relationships?.length || 0), 0) || 0,
      } : null,
      database_exit_points: databaseExits,
    },
    [
      { type: 'summary', id: 'data-summary', label: 'CAS data summary' },
      ...evidenceForIds(cas, entityNodeIds, 'data_entity'),
      ...evidenceForIds(cas, databaseExits.exit_points.map(exit => exit.id), 'exit_point'),
    ],
    checks,
    gaps
  );
}

function testProbe(cas: CASOutput): AnswerProbe {
  const tests = findTests(cas, { limit: 10 });
  const summary = getFlowCoverage(cas) as ReturnType<typeof getFlowCoverage> & { total_flows: number };
  const checks: string[] = [];
  const gaps: string[] = [];

  if (tests.total_suites > 0) checks.push(`Found ${tests.total_suites} test suites`);
  else checks.push('CAS reports no test suites for this repository');

  if (summary.total_flows > 0) checks.push(`Found flow coverage for ${summary.total_flows} flows`);
  else checks.push('CAS reports no flow coverage records for this repository');

  return probe(
    'tests',
    'What tests and flow coverage exist for this system?',
    {
      tests,
      flow_coverage: summary,
    },
    [
      { type: 'summary', id: 'test-summary', label: 'CAS test summary' },
      ...tests.suites.slice(0, 5).map(suite => ({
        type: 'test' as const,
        id: suite.file_path,
        label: suite.name,
        file: suite.file_path,
      })),
    ],
    checks,
    gaps
  );
}

function externalProbe(cas: CASOutput): AnswerProbe {
  const exits = getExitPoints(cas, { limit: 15 });
  const services = getExternalServices(cas);
  const checks: string[] = [];
  const gaps: string[] = [];

  if (exits.total > 0) checks.push(`Found ${exits.total} exit points`);
  else gaps.push('No exit points found');

  if (services.length > 0) checks.push(`Found ${services.length} external services`);
  else if (exits.total > 0) checks.push('Exit points available even without service rollups');
  else gaps.push('No external service rollups found');

  return probe(
    'external-boundaries',
    'What external systems, files, messages, APIs, or caches does this code touch?',
    {
      exit_points: exits,
      external_services: services,
    },
    evidenceForIds(cas, exits.exit_points.map(exit => exit.id), 'exit_point'),
    checks,
    gaps
  );
}

function securityProbe(cas: CASOutput): AnswerProbe {
  const security = getSecurityOverview(cas);
  const authNodes = searchNodes(cas, 'auth', { limit: 10 });
  const checks: string[] = [];
  const gaps: string[] = [];

  if (security.boundary_count > 0) checks.push(`Found ${security.boundary_count} security boundaries`);
  if (security.context_count > 0) checks.push(`Found ${security.context_count} security contexts`);
  if (authNodes.length > 0) checks.push(`Found ${authNodes.length} auth-related nodes`);
  if (checks.length === 0) checks.push('CAS reports no security boundaries, contexts, or auth-related nodes for this repository');

  return probe(
    'security',
    'Where are the security boundaries and auth-related code?',
    {
      security,
      auth_nodes: authNodes,
    },
    [
      { type: 'summary', id: 'security-summary', label: 'CAS security summary' },
      ...evidenceForIds(cas, authNodes.map(node => node.id), 'node'),
    ],
    checks,
    gaps
  );
}

function validateEvidence(cas: CASOutput, probeResult: AnswerProbe): AnswerProbe {
  const nodeIds = new Set(cas.nodes.map(node => node.id));
  const edgeIds = new Set(cas.edges.map(edge => edge.id));
  const entryPointIds = new Set((cas.entry_points || []).map(entry => entry.id));
  const exitPointIds = new Set((cas.exit_points || []).map(exit => exit.id));
  const chainIds = new Set((cas.call_chains || []).map(chain => chain.id));
  const factIds = new Set((cas.analysis_facts || []).map(fact => fact.id));
  const dataEntityIds = new Set((cas.data_entities || []).map(entity => entity.id));
  const missing = probeResult.evidence.filter(ref => {
    if (ref.type === 'summary' || ref.type === 'test') return false;
    if (ref.type === 'node') return !nodeIds.has(ref.id);
    if (ref.type === 'edge') return !edgeIds.has(ref.id);
    if (ref.type === 'entry_point') return !entryPointIds.has(ref.id);
    if (ref.type === 'exit_point') return !exitPointIds.has(ref.id);
    if (ref.type === 'call_chain') return !chainIds.has(ref.id);
    if (ref.type === 'fact') return !factIds.has(ref.id);
    if (ref.type === 'data_entity') return !dataEntityIds.has(ref.id);
    return false;
  });

  if (missing.length === 0) {
    probeResult.checks.push('All evidence references resolve');
  } else {
    probeResult.gaps.push(`Missing evidence refs: ${missing.map(ref => ref.id).join(', ')}`);
    probeResult.score = Math.max(0, probeResult.score - 25);
    probeResult.status = statusFromScore(probeResult.score);
  }

  return probeResult;
}

function scoreCas(cas: CASOutput, target: RepoTarget, durationMs: number): TargetAnswerReport {
  const probes = [
    overviewProbe(cas),
    entryPointProbe(cas),
    flowProbe(cas),
    impactProbe(cas),
    dataProbe(cas),
    testProbe(cas),
    externalProbe(cas),
    securityProbe(cas),
  ].map(result => validateEvidence(cas, result));

  const analysisErrorEntries = cas.analysis_errors || [];
  const analysisErrors = analysisErrorEntries.filter(entry => (entry.severity ?? 'error') === 'error').length;
  if (analysisErrors > 0) {
    probes.unshift(probe(
      'analysis-errors',
      'Did analysis complete without errors?',
      { analysis_errors: analysisErrorEntries.filter(entry => (entry.severity ?? 'error') === 'error') },
      [],
      [],
      [`${analysisErrors} analysis errors (${analysisErrorEntries.length - analysisErrors} non-blocking warnings not counted)`]
    ));
  }

  const score = Math.round(probes.reduce((sum, result) => sum + result.score, 0) / probes.length);
  const status: GateStatus = analysisErrors > 0 || probes.some(result => result.status === 'fail')
    ? 'fail'
    : probes.some(result => result.status === 'warn') ? 'warn' : 'pass';
  const topGaps = probes
    .flatMap(result => result.gaps.map(gap => `${result.id}: ${gap}`))
    .slice(0, 8);

  return {
    name: target.name,
    path: target.path,
    status,
    score,
    durationMs,
    summary: {
      nodes: cas.nodes.length,
      edges: cas.edges.length,
      entryPoints: cas.entry_points?.length || 0,
      exitPoints: cas.exit_points?.length || 0,
      methodCalls: cas.method_calls?.length || 0,
      callChains: cas.call_chains?.length || 0,
      facts: cas.analysis_facts?.length || 0,
      analysisErrors,
    },
    probes,
    topGaps,
  };
}

async function analyzeTarget(target: RepoTarget): Promise<TargetAnswerReport> {
  const startedAt = Date.now();
  const cas = await analyzeForBench(target.path);
  return scoreCas(cas, target, Date.now() - startedAt);
}

function aggregateStatus(reports: TargetAnswerReport[]): GateStatus {
  if (reports.some(report => report.status === 'fail')) return 'fail';
  if (reports.some(report => report.status === 'warn')) return 'warn';
  return 'pass';
}

function printReport(report: AnswerGauntletReport): void {
  console.log(`Answer gauntlet: ${report.status.toUpperCase()} (${report.score}/100)`);
  for (const target of report.targets) {
    console.log([
      `${target.status.toUpperCase().padEnd(4)} ${String(target.score).padStart(3)}/100`,
      target.name,
      `${target.summary.entryPoints} entries`,
      `${target.summary.exitPoints} exits`,
      `${target.summary.callChains} chains`,
      `${target.summary.facts} facts`,
    ].join(' | '));
    for (const gap of target.topGaps) {
      console.log(`  - ${gap}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const discoveredTargets = args.repos.length > 0 ? args.repos : await discoverTargets(args.devRoot);
  const targets = typeof args.maxTargets === 'number' ? discoveredTargets.slice(0, args.maxTargets) : discoveredTargets;

  if (targets.length === 0) {
    throw new Error(`No answer gauntlet targets found under ${args.devRoot}`);
  }

  if (args.dryRun) {
    for (const target of targets) {
      console.log(`${target.name}: ${target.path}`);
    }
    return;
  }

  const targetReports: TargetAnswerReport[] = [];
  for (const target of targets) {
    console.log(`Answering ${target.name}: ${target.path}`);
    targetReports.push(await analyzeTarget(target));
  }

  const status = aggregateStatus(targetReports);
  const score = Math.round(targetReports.reduce((sum, target) => sum + target.score, 0) / targetReports.length);
  const report: AnswerGauntletReport = {
    generatedAt: new Date().toISOString(),
    status,
    score,
    targets: targetReports,
  };

  await fs.ensureDir(path.dirname(args.outputPath));
  await fs.writeJson(args.outputPath, report, { spaces: 2 });
  printReport(report);
  console.log(`Report: ${args.outputPath}`);

  if (status === 'fail' || (status === 'warn' && args.failOnWarn)) {
    process.exitCode = 1;
  }
}

if (isDirectCliInvocation('answer-gauntlet')) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export {
  analyzeTarget,
  scoreCas,
  type AnswerGauntletReport,
  type TargetAnswerReport,
  type AnswerProbe,
};
