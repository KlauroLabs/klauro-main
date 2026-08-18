import * as fs from 'fs-extra';
import * as path from 'path';
import { analyzeForBench } from './gauntlet/product-analysis';
import { discoverTargets, type RepoTarget } from './gauntlet';
import { evaluateAgentReadiness } from './agent-adoption';
import { validateCASContract } from './cas-contract';
import { buildCrossRepositoryLinks, runAnswerPack } from './product';
import { getRuntimeEventContract } from './runtime-contract';
import { getRuntimeSdkPackage, isRuntimeSdkPackageReady } from './runtime-sdk';
import { getTestDiscoveryEvidence } from './test-discovery';
import { getAgentDefaultConfig } from './agent-defaults';
import { getIntegrationDepthReport } from './integration-depth';
import { buildWorkspaceGraph, summarizeWorkspaceGraph } from './workspace-graph';
import { clearLoadedAnalysisCache } from './storage';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { isDirectCliInvocation } from './cli-invocation';

type GateStatus = 'pass' | 'warn' | 'fail';

interface VisionTargetReport {
  name: string;
  path: string;
  status: GateStatus;
  score: number;
  durationMs: number;
  cas_contract: ReturnType<typeof validateCASContract>;
  agent_readiness: ReturnType<typeof evaluateAgentReadiness>;
  answer_pack: ReturnType<typeof runAnswerPack>;
  runtime_contract: ReturnType<typeof getRuntimeEventContract>;
  runtime_sdk: ReturnType<typeof getRuntimeSdkPackage>;
  agent_defaults: Awaited<ReturnType<typeof getAgentDefaultConfig>>;
  integration_depth: ReturnType<typeof getIntegrationDepthReport>;
  test_discovery: Awaited<ReturnType<typeof getTestDiscoveryEvidence>>;
}

const CROSS_REPOSITORY_NODE_TYPES = new Set([
  'class',
  'interface',
  'type',
  'enum',
  'model',
  'entity',
  'dto',
  'use',
  'import',
]);

export function projectCasForCrossRepositoryAnalysis(cas: CASOutput): CASOutput {
  const entryPoints = cas.entry_points || [];
  const exitPoints = cas.exit_points || [];
  const referencedNodeIds = new Set<string>();
  for (const entryPoint of entryPoints) {
    if (entryPoint.source_node) referencedNodeIds.add(entryPoint.source_node);
    if (entryPoint.handler?.node_id) referencedNodeIds.add(entryPoint.handler.node_id);
  }
  for (const exitPoint of exitPoints) {
    if (exitPoint.source_node) referencedNodeIds.add(exitPoint.source_node);
  }
  for (const service of cas.external_services || []) {
    for (const nodeId of service.connected_nodes || []) referencedNodeIds.add(nodeId);
  }
  for (const library of cas.libraries || []) {
    for (const nodeId of library.connected_nodes || []) referencedNodeIds.add(nodeId);
  }
  for (const variable of cas.configuration?.environment_variables || []) {
    for (const nodeId of variable.used_by || []) referencedNodeIds.add(nodeId);
  }

  return {
    cas_version: cas.cas_version,
    analysis_id: cas.analysis_id,
    analysis_timestamp: cas.analysis_timestamp,
    analyzer_contributions: cas.analyzer_contributions,
    progressive_levels: cas.progressive_levels,
    system: cas.system,
    nodes: (cas.nodes || []).filter(node => CROSS_REPOSITORY_NODE_TYPES.has(node.type) || referencedNodeIds.has(node.id)),
    edges: [],
    entry_points: entryPoints,
    exit_points: exitPoints,
    call_chains: [],
    entities: cas.entities || [],
    database_schema: cas.database_schema,
    external_services: cas.external_services || [],
    libraries: cas.libraries || [],
    dependencies: cas.dependencies,
    configuration: cas.configuration,
  } as CASOutput;
}

export function visionReportTimestamps(generatedAt = new Date().toISOString()): {
  generated_at: string;
  generatedAt: string;
} {
  return { generated_at: generatedAt, generatedAt };
}

function parseArgs(argv: string[]) {
  const repos: RepoTarget[] = [];
  let devRoot = path.join(process.env.HOME || '', 'dev');
  let outputPath = path.join(process.cwd(), '.klauro-vision-gauntlet', 'latest-report.json');
  let dryRun = false;
  let maxTargets: number | undefined;
  let requireCrossRepoLinks = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') {
      const value = argv[++i];
      if (!value) throw new Error('--repo requires a path or name=path value');
      const [namePart, repoPathPart] = value.includes('=') ? value.split('=') : [undefined, value];
      const repoPath = path.resolve(repoPathPart);
      repos.push({ name: namePart || path.basename(repoPath), path: repoPath, expectation: {} });
    } else if (arg === '--dev-root') {
      devRoot = path.resolve(argv[++i]);
    } else if (arg === '--output') {
      outputPath = path.resolve(argv[++i]);
    } else if (arg === '--max-targets') {
      maxTargets = Number(argv[++i]);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--require-cross-repo-links') {
      requireCrossRepoLinks = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { repos, devRoot, outputPath, maxTargets, dryRun, requireCrossRepoLinks };
}

function printHelp(): void {
  console.log([
    'Usage: npm run vision-gauntlet -- [options]',
    '',
    'Options:',
    '  --repo name=/path/to/repo   Run a specific repo. May be repeated.',
    '  --dev-root /path           Root used for default repo discovery.',
    '  --output /path/report.json Write JSON report.',
    '  --max-targets n            Limit discovered targets.',
    '  --require-cross-repo-links Require at least one resolved link when analyzing multiple repositories.',
    '  --dry-run                  Print selected targets without analysis.',
  ].join('\n'));
}

async function analyzeTarget(target: RepoTarget): Promise<{ report: VisionTargetReport; cas: CASOutput }> {
  const startedAt = Date.now();
  const cas = await analyzeForBench(target.path);
  const casContract = validateCASContract(cas);
  const testEvidence = await getTestDiscoveryEvidence(target.path, cas);
  const agentReadiness = evaluateAgentReadiness(cas, target.path, { testEvidence });
  const answerPack = runAnswerPack(cas, target.path);
  const runtimeEventContract = getRuntimeEventContract(cas, { limit: 50 });
  const runtimeSdkPackage = getRuntimeSdkPackage(cas, { limit: 10 });
  const runtimeSdkReady = isRuntimeSdkPackageReady(runtimeSdkPackage);
  const agentDefaults = await getAgentDefaultConfig(cas, target.path, {}, { assumeFresh: true });
  const integrationReport = getIntegrationDepthReport(cas);
  const scores = [
    casContract.score,
    agentReadiness.score,
    agentDefaults.agent_context_ready ? 100 : 70,
    integrationReport.score,
    answerPack.gaps.length === 0 ? 100 : Math.max(60, 100 - answerPack.gaps.length * 8),
    runtimeEventContract.totals.runtime_static_links > 0 ? 100 : 75,
    runtimeSdkReady ? 100 : 75,
  ];
  const score = Math.round(average(scores));
  const status = aggregateStatus([
    casContract.status,
    agentReadiness.status,
    agentDefaults.agent_context_ready ? 'pass' : 'warn',
    integrationReport.status === 'missing-depth' ? 'warn' : 'pass',
    answerPack.gaps.length === 0 ? 'pass' : 'warn',
    runtimeEventContract.totals.runtime_static_links > 0 ? 'pass' : 'warn',
    runtimeSdkReady ? 'pass' : 'warn',
  ]);

  return {
    cas,
    report: {
      name: target.name,
      path: target.path,
      status,
      score,
      durationMs: Date.now() - startedAt,
      cas_contract: casContract,
      agent_readiness: agentReadiness,
      answer_pack: answerPack,
      runtime_contract: runtimeEventContract,
      runtime_sdk: runtimeSdkPackage,
      agent_defaults: agentDefaults,
      integration_depth: integrationReport,
      test_discovery: testEvidence,
    },
  };
}

function aggregateStatus(statuses: GateStatus[]): GateStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

function average(values: number[]): number {
  if (values.length === 0) return 100;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const discovered = args.repos.length > 0 ? args.repos : await discoverTargets(args.devRoot);
  const targets = typeof args.maxTargets === 'number' ? discovered.slice(0, args.maxTargets) : discovered;

  if (targets.length === 0) {
    throw new Error(`No vision gauntlet targets found under ${args.devRoot}`);
  }

  if (args.dryRun) {
    for (const target of targets) {
      console.log(`${target.name}: ${target.path}`);
    }
    return;
  }

  const targetReports: VisionTargetReport[] = [];
  const repositories: Array<{ path: string; name: string; cas: CASOutput }> = [];

  for (const target of targets) {
    console.log(`Analyzing ${target.name}: ${target.path}`);
    try {
      const result = await analyzeTarget(target);
      targetReports.push(result.report);
      repositories.push({ path: target.path, name: target.name, cas: projectCasForCrossRepositoryAnalysis(result.cas) });
    } finally {
      clearLoadedAnalysisCache();
    }
  }

  const crossRepo = buildCrossRepositoryLinks(repositories);
  const workspace = buildWorkspaceGraph('vision-gauntlet', repositories);
  const workspaceSummary = summarizeWorkspaceGraph(workspace);
  const crossRepoStatus: GateStatus = args.requireCrossRepoLinks && repositories.length > 1 && crossRepo.links.length === 0 ? 'warn' : 'pass';
  const crossRepoScore = args.requireCrossRepoLinks && repositories.length > 1 ? [crossRepo.links.length > 0 ? 100 : 75] : [];
  const report = {
    ...visionReportTimestamps(),
    status: aggregateStatus([...targetReports.map(target => target.status), crossRepoStatus]),
    score: Math.round(average([
      ...targetReports.map(target => target.score),
      ...crossRepoScore,
    ])),
    target_count: targetReports.length,
    targets: targetReports,
    cross_repository: crossRepo,
    workspace_graph: workspaceSummary,
  };

  await fs.ensureDir(path.dirname(args.outputPath));
  await fs.writeJson(args.outputPath, report, { spaces: 2 });
  printReport(report);

  if (report.status === 'fail') process.exitCode = 1;
}

function printReport(report: {
  generated_at: string;
  generatedAt: string;
  status: GateStatus;
  score: number;
  targets: VisionTargetReport[];
  cross_repository: ReturnType<typeof buildCrossRepositoryLinks>;
  workspace_graph: ReturnType<typeof summarizeWorkspaceGraph>;
}): void {
  console.log(`Vision gauntlet: ${report.status.toUpperCase()} (${report.score}/100)`);
  for (const target of report.targets) {
    console.log([
      `${target.status.toUpperCase().padEnd(4)} ${String(target.score).padStart(3)}/100`,
      target.name,
      `CAS ${target.cas_contract.score}/100`,
      `agent ${target.agent_readiness.score}/100`,
      `defaults ${target.agent_defaults.agent_context_ready ? 'ready' : 'review'}`,
      `integrations ${target.integration_depth.score}/100`,
      `answers ${target.answer_pack.gaps.length === 0 ? 'ready' : `${target.answer_pack.gaps.length} gaps`}`,
      `runtime ${target.runtime_contract.totals.runtime_static_links} links`,
      `sdk ${isRuntimeSdkPackageReady(target.runtime_sdk) ? 'ready' : 'incomplete'}`,
      `${Math.round(target.durationMs / 1000)}s`,
    ].join(' | '));
    for (const gate of target.cas_contract.gates.filter(result => result.status !== 'pass').slice(0, 4)) {
      console.log(`  - CAS ${gate.id}: ${gate.detail}`);
    }
    for (const gap of target.agent_readiness.adoption_gaps.slice(0, 4)) {
      console.log(`  - agent ${gap}`);
    }
    if (target.test_discovery.status !== 'cas-covered') {
      console.log(`  - tests ${target.test_discovery.summary}`);
    }
  }
  console.log(`Cross-repo links: ${report.cross_repository.links.length}, confirmed ${report.cross_repository.certainty.confirmed}, likely ${report.cross_repository.certainty.likely}, conflicts ${report.cross_repository.conflicts.length}`);
  console.log(`Workspace graph: ${report.workspace_graph.link_count} links, ${report.workspace_graph.linked_repositories} linked repositories, ${report.workspace_graph.conflicts} conflicts`);
}

if (isDirectCliInvocation('vision-gauntlet')) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
