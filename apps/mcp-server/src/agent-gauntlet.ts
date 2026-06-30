import * as fs from 'fs-extra';
import * as path from 'path';
import { analyzeForBench } from './gauntlet/product-analysis';
import { discoverTargets, type RepoTarget } from './gauntlet';
import { evaluateAgentReadiness, type AgentReadinessReport } from './agent-adoption';
import { getTestDiscoveryEvidence } from './test-discovery';
import { isDirectCliInvocation } from './cli-invocation';

type GateStatus = 'pass' | 'warn' | 'fail';

interface TargetAgentReport extends AgentReadinessReport {
  durationMs: number;
}

interface AgentGauntletReport {
  generatedAt: string;
  status: GateStatus;
  score: number;
  defaultUseTargets: number;
  targets: TargetAgentReport[];
}

function parseArgs(argv: string[]) {
  const repos: RepoTarget[] = [];
  let devRoot = path.join(process.env.HOME || '', 'dev');
  let outputPath = path.join(process.cwd(), '.klauro-agent-gauntlet', 'latest-report.json');
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
    'Usage: npm run agent-gauntlet -- [options]',
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

async function analyzeTarget(target: RepoTarget): Promise<TargetAgentReport> {
  const startedAt = Date.now();
  const output = await analyzeForBench(target.path);
  const testEvidence = await getTestDiscoveryEvidence(target.path, output);
  return {
    ...evaluateAgentReadiness(output, target.path, { testEvidence }),
    name: target.name,
    durationMs: Date.now() - startedAt,
  };
}

function aggregateStatus(reports: TargetAgentReport[]): GateStatus {
  if (reports.some(report => report.status === 'fail' || !report.agent_context_ready)) return 'fail';
  if (reports.some(report => report.status === 'warn')) return 'warn';
  return 'pass';
}

function printReport(report: AgentGauntletReport): void {
  console.log(`Agent adoption gauntlet: ${report.status.toUpperCase()} (${report.score}/100)`);
  console.log(`Agent-ready targets: ${report.defaultUseTargets}/${report.targets.length}`);
  for (const target of report.targets) {
    console.log([
      `${target.status.toUpperCase().padEnd(4)} ${String(target.score).padStart(3)}/100`,
      target.agent_context_ready ? 'agent-context-ready' : 'not-default',
      target.name,
      `${target.summary.nodes} nodes`,
      `${target.summary.entry_points} entries`,
      `${target.summary.call_chains} chains`,
      `${target.summary.runtime_static_links} runtime links`,
      `${Math.round(target.durationMs / 1000)}s`,
    ].join(' | '));
    if (target.adoption_gaps.length > 0) {
      for (const gap of target.adoption_gaps) {
        console.log(`  - ${gap}`);
      }
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const discoveredTargets = args.repos.length > 0 ? args.repos : await discoverTargets(args.devRoot);
  const targets = typeof args.maxTargets === 'number' ? discoveredTargets.slice(0, args.maxTargets) : discoveredTargets;

  if (targets.length === 0) {
    throw new Error(`No agent gauntlet targets found under ${args.devRoot}`);
  }

  if (args.dryRun) {
    for (const target of targets) {
      console.log(`${target.name}: ${target.path}`);
    }
    return;
  }

  const targetReports: TargetAgentReport[] = [];
  for (const target of targets) {
    console.log(`Analyzing ${target.name}: ${target.path}`);
    targetReports.push(await analyzeTarget(target));
  }

  const status = aggregateStatus(targetReports);
  const score = Math.round(targetReports.reduce((sum, target) => sum + target.score, 0) / targetReports.length);
  const report: AgentGauntletReport = {
    generatedAt: new Date().toISOString(),
    status,
    score,
    defaultUseTargets: targetReports.filter(target => target.agent_context_ready).length,
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

if (isDirectCliInvocation('agent-gauntlet')) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
