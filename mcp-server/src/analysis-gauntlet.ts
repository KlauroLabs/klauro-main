import * as fs from 'fs-extra';
import * as path from 'path';
import { getOrchestrator } from './analyzer';
import {
  evaluateAgentTaskProof,
  evaluateAnalysisTruth,
  getFrameworkDepthReport,
  getRuntimeInstrumentationPlan,
  getSemanticMap,
  loadTruthExpectation,
  type AnalysisTruthExpectation,
} from './analysis-mastery';
import { validateCASContract } from './cas-contract';

type GateStatus = 'pass' | 'warn' | 'fail';

interface Target {
  name: string;
  path: string;
  expectation?: AnalysisTruthExpectation;
}

interface TargetReport {
  name: string;
  path: string;
  status: GateStatus;
  score: number;
  durationMs: number;
  truth: ReturnType<typeof evaluateAnalysisTruth>;
  framework_depth: ReturnType<typeof getFrameworkDepthReport>;
  runtime_plan: ReturnType<typeof getRuntimeInstrumentationPlan>;
  agent_task_proof: ReturnType<typeof evaluateAgentTaskProof>;
  cas_contract: ReturnType<typeof validateCASContract>;
  semantic_map: {
    files: number;
    relationships: number;
    method_calls: number;
  };
  gaps: string[];
  observations: string[];
}

interface Report {
  generatedAt: string;
  status: GateStatus;
  score: number;
  targets: TargetReport[];
}

function parseArgs(argv: string[]) {
  const repos: Target[] = [];
  let outputPath = path.join(process.cwd(), '.unravl-analysis-gauntlet', 'latest-report.json');
  let includeDefaultFixture = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') {
      const value = argv[++i];
      if (!value) throw new Error('--repo requires a path or name=path value');
      const [namePart, repoPathPart] = value.includes('=') ? value.split('=') : [undefined, value];
      const repoPath = path.resolve(repoPathPart);
      repos.push({ name: namePart || path.basename(repoPath), path: repoPath });
    } else if (arg === '--output') {
      outputPath = path.resolve(argv[++i]);
    } else if (arg === '--no-default-fixture') {
      includeDefaultFixture = false;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { repos, outputPath, includeDefaultFixture };
}

function printHelp(): void {
  console.log([
    'Usage: npm run analysis-gauntlet -- [options]',
    '',
    'Options:',
    '  --repo name=/path/to/repo   Run a specific repo. May be repeated.',
    '  --repo /path/to/repo        Run a specific repo using folder name.',
    '  --output /path/report.json  Write JSON report.',
    '  --no-default-fixture        Skip the built-in ground-truth fixture.',
  ].join('\n'));
}

async function defaultTargets(includeDefaultFixture: boolean): Promise<Target[]> {
  if (!includeDefaultFixture) return [];
  const fixtureRoot = path.join(process.cwd(), 'fixtures', 'analysis-truth');
  const entries = await fs.readdir(fixtureRoot, { withFileTypes: true });
  const targets: Target[] = [];

  for (const entry of entries.filter(candidate => candidate.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const fixturePath = path.join(fixtureRoot, entry.name);
    const expectationPath = path.join(fixturePath, 'analysis-expectations.json');
    if (!await fs.pathExists(expectationPath)) continue;
    const expectation = await fs.readJson(expectationPath);
    targets.push({
      name: expectation.name || `${entry.name}-truth-fixture`,
      path: fixturePath,
      expectation,
    });
  }

  return targets;
}

async function analyzeTarget(target: Target): Promise<TargetReport> {
  const startedAt = Date.now();
  const cas = await getOrchestrator().orchestrateAnalysis(target.path);
  const expectation = target.expectation || await loadTruthExpectation(target.path);
  if (!expectation) throw new Error(`${target.name}: no analysis expectation found`);

  const truth = evaluateAnalysisTruth(cas, expectation);
  const frameworkDepth = getFrameworkDepthReport(cas);
  const runtimePlan = getRuntimeInstrumentationPlan(cas, { limit: 20 });
  const casContract = validateCASContract(cas);
  const agentTaskProof = evaluateAgentTaskProof(cas, target.path, [
    { task_type: 'orient' },
    { task_type: 'modify', target: expectation.nodes?.[0]?.name || expectation.routes?.[0]?.handler },
    { task_type: 'debug', target: expectation.nodes?.[1]?.name || expectation.routes?.[0]?.path },
  ]);
  const semanticMap = getSemanticMap(cas, { target: expectation.nodes?.[0]?.name, limit: 25 });
  const checks = [
    truth.score,
    frameworkDepth.frameworks.length ? average(frameworkDepth.frameworks.map(row => row.score)) : 100,
    runtimePlan.totals.runtime_static_links > 0 ? 100 : 80,
    casContract.score,
    agentTaskProof.score,
    semanticMap.files.length > 0 ? 100 : 0,
  ];
  const score = Math.round(average(checks));
  const gaps = [
    ...truth.misses.map(miss => `${miss.id}: ${miss.detail}`),
    ...frameworkDepth.uncovered_expectations,
    ...runtimePlan.gaps,
    ...agentTaskProof.tasks
      .filter(task => task.status !== 'pass')
      .flatMap(task => task.gaps.map(gap => `agent:${task.task.task_type || 'orient'}:${gap}`)),
    ...(semanticMap.files.length === 0 ? ['semantic-map: no files resolved'] : []),
  ].slice(0, 25);
  const observations = agentTaskProof.tasks
    .filter(task => task.status === 'pass')
    .flatMap(task => task.gaps.map(gap => `agent:${task.task.task_type || 'orient'}:${gap}`))
    .slice(0, 25);
  const status: GateStatus = truth.status === 'fail' || agentTaskProof.status === 'fail' || semanticMap.files.length === 0
    ? 'fail'
    : frameworkDepth.status === 'fail' || casContract.status === 'fail' ? 'fail'
      : truth.status === 'warn' || agentTaskProof.status === 'warn' || score < 95 ? 'warn' : 'pass';

  return {
    name: target.name,
    path: target.path,
    status,
    score,
    durationMs: Date.now() - startedAt,
    truth,
    framework_depth: frameworkDepth,
    runtime_plan: runtimePlan,
    cas_contract: casContract,
    agent_task_proof: agentTaskProof,
    semantic_map: {
      files: semanticMap.files.length,
      relationships: semanticMap.relationships.length,
      method_calls: semanticMap.method_calls.length,
    },
    gaps,
    observations,
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 100;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function aggregateStatus(reports: TargetReport[]): GateStatus {
  if (reports.some(report => report.status === 'fail')) return 'fail';
  if (reports.some(report => report.status === 'warn')) return 'warn';
  return 'pass';
}

function printReport(report: Report): void {
  console.log(`Analysis mastery gauntlet: ${report.status.toUpperCase()} (${report.score}/100)`);
  for (const target of report.targets) {
    console.log([
      `${target.status.toUpperCase().padEnd(4)} ${String(target.score).padStart(3)}/100`,
      target.name,
      `truth ${target.truth.score}/100`,
      `agent ${target.agent_task_proof.score}/100`,
      `${target.semantic_map.files} semantic files`,
      `${Math.round(target.durationMs / 1000)}s`,
    ].join(' | '));
    for (const gap of target.gaps.slice(0, 8)) {
      console.log(`  - ${gap}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const targets = [...await defaultTargets(args.includeDefaultFixture), ...args.repos];
  if (targets.length === 0) throw new Error('No analysis gauntlet targets configured');

  const reports: TargetReport[] = [];
  for (const target of targets) {
    console.log(`Analyzing ${target.name}: ${target.path}`);
    reports.push(await analyzeTarget(target));
  }

  const report: Report = {
    generatedAt: new Date().toISOString(),
    status: aggregateStatus(reports),
    score: Math.round(average(reports.map(target => target.score))),
    targets: reports,
  };

  await fs.ensureDir(path.dirname(args.outputPath));
  await fs.writeJson(args.outputPath, report, { spaces: 2 });
  printReport(report);
  console.log(`Report: ${args.outputPath}`);

  if (report.status === 'fail') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
