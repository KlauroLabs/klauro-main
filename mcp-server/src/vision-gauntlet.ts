import * as fs from 'fs-extra';
import * as path from 'path';
import { getOrchestrator } from './analyzer';
import { discoverTargets, type RepoTarget } from './gauntlet';
import { evaluateAgentReadiness } from './agent-adoption';
import { validateCASContract } from './cas-contract';
import { buildCrossRepositoryLinks, runAnswerPack } from './product';
import { getRuntimeEventContract } from './runtime-contract';
import type { CASOutput } from '../../backend/src/types/cas.types';

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
}

function parseArgs(argv: string[]) {
  const repos: RepoTarget[] = [];
  let devRoot = path.join(process.env.HOME || '', 'dev');
  let outputPath = path.join(process.cwd(), '.unravl-vision-gauntlet', 'latest-report.json');
  let dryRun = false;
  let maxTargets: number | undefined;

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
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { repos, devRoot, outputPath, maxTargets, dryRun };
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
    '  --dry-run                  Print selected targets without analysis.',
  ].join('\n'));
}

async function analyzeTarget(target: RepoTarget): Promise<{ report: VisionTargetReport; cas: CASOutput }> {
  const startedAt = Date.now();
  const cas = await getOrchestrator().orchestrateAnalysis(target.path);
  const casContract = validateCASContract(cas);
  const agentReadiness = evaluateAgentReadiness(cas, target.path);
  const answerPack = runAnswerPack(cas, target.path);
  const runtimeEventContract = getRuntimeEventContract(cas, { limit: 50 });
  const scores = [
    casContract.score,
    agentReadiness.score,
    answerPack.gaps.length === 0 ? 100 : Math.max(60, 100 - answerPack.gaps.length * 8),
    runtimeEventContract.totals.runtime_static_links > 0 ? 100 : 75,
  ];
  const score = Math.round(average(scores));
  const status = aggregateStatus([
    casContract.status,
    agentReadiness.status,
    answerPack.gaps.length === 0 ? 'pass' : 'warn',
    runtimeEventContract.totals.runtime_static_links > 0 ? 'pass' : 'warn',
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
    const result = await analyzeTarget(target);
    targetReports.push(result.report);
    repositories.push({ path: target.path, name: target.name, cas: result.cas });
  }

  const crossRepo = buildCrossRepositoryLinks(repositories);
  const crossRepoStatus: GateStatus = repositories.length <= 1
    ? 'pass'
    : crossRepo.links.length > 0 ? 'pass' : 'warn';
  const report = {
    generatedAt: new Date().toISOString(),
    status: aggregateStatus([...targetReports.map(target => target.status), crossRepoStatus]),
    score: Math.round(average([
      ...targetReports.map(target => target.score),
      repositories.length <= 1 ? 100 : crossRepo.links.length > 0 ? 100 : 75,
    ])),
    target_count: targetReports.length,
    targets: targetReports,
    cross_repository: crossRepo,
  };

  await fs.ensureDir(path.dirname(args.outputPath));
  await fs.writeJson(args.outputPath, report, { spaces: 2 });
  printReport(report);

  if (report.status === 'fail') process.exitCode = 1;
}

function printReport(report: {
  status: GateStatus;
  score: number;
  targets: VisionTargetReport[];
  cross_repository: ReturnType<typeof buildCrossRepositoryLinks>;
}): void {
  console.log(`Vision gauntlet: ${report.status.toUpperCase()} (${report.score}/100)`);
  for (const target of report.targets) {
    console.log([
      `${target.status.toUpperCase().padEnd(4)} ${String(target.score).padStart(3)}/100`,
      target.name,
      `CAS ${target.cas_contract.score}/100`,
      `agent ${target.agent_readiness.score}/100`,
      `answers ${target.answer_pack.gaps.length === 0 ? 'ready' : `${target.answer_pack.gaps.length} gaps`}`,
      `runtime ${target.runtime_contract.totals.runtime_static_links} links`,
      `${Math.round(target.durationMs / 1000)}s`,
    ].join(' | '));
    for (const gate of target.cas_contract.gates.filter(result => result.status !== 'pass').slice(0, 4)) {
      console.log(`  - CAS ${gate.id}: ${gate.detail}`);
    }
    for (const gap of target.agent_readiness.adoption_gaps.slice(0, 4)) {
      console.log(`  - agent ${gap}`);
    }
  }
  console.log(`Cross-repo links: ${report.cross_repository.links.length}, confirmed ${report.cross_repository.certainty.confirmed}, likely ${report.cross_repository.certainty.likely}, conflicts ${report.cross_repository.conflicts.length}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
