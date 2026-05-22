import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';
import { getOrchestrator } from './analyzer';
import type { CASOutput } from '../../backend/src/types/cas.types';

type GateStatus = 'pass' | 'warn' | 'fail';

interface RepoExpectation {
  minNodes?: number;
  minEdges?: number;
  minEntryPoints?: number;
  minMethodCalls?: number;
  minCallChains?: number;
  requiredFrameworks?: string[];
  requiredLanguages?: string[];
}

interface RepoTarget {
  name: string;
  path: string;
  expectation: RepoExpectation;
}

interface GateResult {
  id: string;
  status: GateStatus;
  score: number;
  detail: string;
}

interface TargetReport {
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
    frameworks: string[];
    languages: string[];
  };
  gates: GateResult[];
  topGaps: string[];
}

interface GauntletReport {
  generatedAt: string;
  status: GateStatus;
  score: number;
  targets: TargetReport[];
}

const DEFAULT_TARGETS: Array<{ name: string; relativePath: string; expectation: RepoExpectation }> = [
  {
    name: 'unravl-proof-of-concept',
    relativePath: 'unravl/proof-of-concept',
    expectation: {
      minNodes: 250,
      minEdges: 150,
      minEntryPoints: 5,
      minMethodCalls: 25,
      minCallChains: 5,
      requiredFrameworks: ['NestJS', 'React'],
      requiredLanguages: ['TypeScript/JavaScript']
    }
  },
  {
    name: 'kadra-ai',
    relativePath: 'personal/kadra.ai',
    expectation: {
      minNodes: 100,
      minEdges: 50
    }
  },
  {
    name: 'money',
    relativePath: 'personal/money',
    expectation: {
      minNodes: 150,
      minEdges: 75,
      requiredLanguages: ['TypeScript/JavaScript', 'Python', 'Rust']
    }
  },
  {
    name: 'zerac-ui',
    relativePath: 'zerac/zerac-ui',
    expectation: {
      minNodes: 75,
      minEdges: 40,
      requiredFrameworks: ['React']
    }
  },
  {
    name: 'zerac-api',
    relativePath: 'zerac/zerac-api',
    expectation: {
      minNodes: 75,
      minEdges: 40
    }
  },
  {
    name: 'zerac-demo',
    relativePath: 'zerac/zerac-demo',
    expectation: {
      minNodes: 75,
      minEdges: 40,
      requiredLanguages: ['Go', 'Rust']
    }
  },
  {
    name: 'zerac-scan',
    relativePath: 'zerac/zerac-scan',
    expectation: {
      minNodes: 50,
      minEdges: 25,
      requiredLanguages: ['Rust']
    }
  },
  {
    name: 'soon-sync',
    relativePath: 'soon/soon-sync',
    expectation: {
      minNodes: 75,
      minEdges: 40
    }
  },
  {
    name: 'soon-sync-root',
    relativePath: 'soon-sync',
    expectation: {
      minNodes: 75,
      minEdges: 40
    }
  },
  {
    name: 'soon-ui',
    relativePath: 'soon/soon-ui',
    expectation: {
      minNodes: 75,
      minEdges: 40,
      requiredFrameworks: ['React']
    }
  },
  {
    name: 'soon-bos',
    relativePath: 'soon/soon-bos',
    expectation: {
      minNodes: 75,
      minEdges: 40
    }
  },
  {
    name: 'soundsyft',
    relativePath: 'personal/cleanmusic',
    expectation: {
      minNodes: 75,
      minEdges: 40,
      requiredLanguages: ['Python']
    }
  },
  {
    name: 'soundsyft-backend',
    relativePath: 'personal/cleanmusic/backend',
    expectation: {
      minNodes: 75,
      minEdges: 40,
      requiredLanguages: ['Python']
    }
  }
];

function parseArgs(argv: string[]) {
  const repos: RepoTarget[] = [];
  let devRoot = path.join(process.env.HOME || '', 'dev');
  let outputPath = path.join(process.cwd(), '.unravl-gauntlet', 'latest-report.json');
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
        expectation: {}
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
    'Usage: npm run gauntlet -- [options]',
    '',
    'Options:',
    '  --repo name=/path/to/repo   Run a specific repo. May be repeated.',
    '  --repo /path/to/repo        Run a specific repo using folder name.',
    '  --dev-root /path           Root used for default repo discovery.',
    '  --output /path/report.json  Write JSON report.',
    '  --max-targets n            Limit discovered targets.',
    '  --dry-run                  Print selected targets without analysis.',
    '  --fail-on-warn             Exit nonzero for warnings as well as failures.'
  ].join('\n'));
}

async function discoverTargets(devRoot: string): Promise<RepoTarget[]> {
  const targets: RepoTarget[] = [];

  for (const candidate of DEFAULT_TARGETS) {
    const repoPath = path.join(devRoot, candidate.relativePath);
    if (await fs.pathExists(repoPath)) {
      if (!await repoHasAnalyzableSource(repoPath)) {
        continue;
      }
      if (targets.some(target => path.resolve(target.path) === path.resolve(repoPath))) {
        continue;
      }
      targets.push({
        name: candidate.name,
        path: repoPath,
        expectation: await resolveExpectation(repoPath, candidate.expectation)
      });
    }
  }

  return targets;
}

async function repoHasAnalyzableSource(repoPath: string): Promise<boolean> {
  const matches = await glob([
    '**/package.json',
    '**/pyproject.toml',
    '**/requirements.txt',
    '**/Cargo.toml',
    '**/go.mod',
    '**/pom.xml',
    '**/*.csproj',
    '**/*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,cs,php,prisma}',
  ], {
    cwd: repoPath,
    ignore: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.git/**',
      '**/target/**',
      '**/coverage/**',
      '**/vendor/**',
      '**/vendors/**',
      '**/site-packages/**',
      '**/.sourcemaps/**',
      '**/sourcemaps/**',
      '**/*.js.map',
      '**/*.css.map',
      '**/*.bundle.js',
      '**/*.bundle.css',
      '**/*.min.js',
      '**/*.min.css',
      '**/Generated/**',
      '**/generated/**',
      '**/.next/**',
    ],
    nodir: true,
  });

  return matches.length > 0;
}

async function resolveExpectation(repoPath: string, expectation: RepoExpectation): Promise<RepoExpectation> {
  if (!expectation.requiredLanguages?.length) return expectation;

  const requiredLanguages = (
    await Promise.all(expectation.requiredLanguages.map(async language =>
      await repoAppearsToContainLanguage(repoPath, language) ? language : null
    ))
  ).filter((language): language is string => Boolean(language));

  return {
    ...expectation,
    requiredLanguages
  };
}

async function repoAppearsToContainLanguage(repoPath: string, language: string): Promise<boolean> {
  const patternsByLanguage: Record<string, string[]> = {
    'TypeScript/JavaScript': ['**/package.json', '**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    Python: ['**/pyproject.toml', '**/requirements.txt', '**/*.py'],
    Rust: ['**/Cargo.toml', '**/*.rs'],
    Go: ['**/go.mod', '**/*.go']
  };
  const patterns = patternsByLanguage[language];
  if (!patterns) return true;

  const matches = await glob(patterns, {
    cwd: repoPath,
    ignore: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.git/**',
      '**/target/**',
      '**/coverage/**',
      '**/vendor/**',
      '**/vendors/**',
      '**/site-packages/**',
      '**/.sourcemaps/**',
      '**/sourcemaps/**',
      '**/*.js.map',
      '**/*.css.map',
      '**/*.bundle.js',
      '**/*.bundle.css',
      '**/*.min.js',
      '**/*.min.css',
      '**/Generated/**',
      '**/generated/**'
    ],
    nodir: true
  });

  return matches.length > 0;
}

function countMethodCalls(output: CASOutput): number {
  return output.method_calls?.length ||
    output.nodes.reduce((total, node) => total + (node.call_graph?.calls?.length || 0), 0);
}

function detectedLanguages(output: CASOutput): string[] {
  return output.system.technologies?.languages?.map(language => language.name).filter(Boolean) || [];
}

function detectedFrameworks(output: CASOutput): string[] {
  return output.system.technologies?.frameworks?.map(framework => framework.name).filter(Boolean) || [];
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 1;
  return Math.max(0, Math.min(1, numerator / denominator));
}

function normalizedScore(value: number): number {
  const score = value > 1 ? value : value * 100;
  return Math.max(0, Math.min(100, score));
}

function gate(id: string, status: GateStatus, score: number, detail: string): GateResult {
  return { id, status, score: Math.round(score), detail };
}

function scoreMinimum(id: string, actual: number, expected = 1): GateResult {
  const coverage = ratio(actual, expected);
  const status: GateStatus = coverage >= 1 ? 'pass' : coverage >= 0.5 ? 'warn' : 'fail';
  return gate(id, status, coverage * 100, `${actual}/${expected}`);
}

function scoreRequiredNames(id: string, actual: string[], expected: string[] = []): GateResult {
  if (expected.length === 0) return gate(id, 'pass', 100, 'No required names configured');

  const normalizedActual = actual.map(value => value.toLowerCase());
  const missing = expected.filter(value => !normalizedActual.some(actualValue =>
    actualValue.includes(value.toLowerCase()) || value.toLowerCase().includes(actualValue)
  ));
  const coverage = ratio(expected.length - missing.length, expected.length);
  const status: GateStatus = missing.length === 0 ? 'pass' : coverage >= 0.5 ? 'warn' : 'fail';

  return gate(id, status, coverage * 100, missing.length === 0 ? 'All present' : `Missing: ${missing.join(', ')}`);
}

function scoreCas(output: CASOutput, target: RepoTarget, durationMs: number): TargetReport {
  const entryPoints = output.entry_points || [];
  const exitPoints = output.exit_points || [];
  const methodCalls = countMethodCalls(output);
  const callChains = output.call_chains?.length || 0;
  const facts = output.analysis_facts?.length || 0;
  const graphIntegrity = output.validation?.graph_integrity;
  const languages = detectedLanguages(output);
  const frameworks = detectedFrameworks(output);
  const analysisErrors = output.analysis_errors?.length || 0;

  const gates: GateResult[] = [
    gate('analysis-errors', analysisErrors === 0 ? 'pass' : 'fail', analysisErrors === 0 ? 100 : 0, `${analysisErrors} analysis errors`),
    scoreMinimum('nodes', output.nodes.length, target.expectation.minNodes || 25),
    scoreMinimum('edges', output.edges.length, target.expectation.minEdges || 10),
    scoreMinimum('entry-points', entryPoints.length, target.expectation.minEntryPoints || 1),
    scoreMinimum('method-calls', methodCalls, target.expectation.minMethodCalls || 1),
    scoreMinimum('call-chains', callChains, target.expectation.minCallChains || 1),
    scoreRequiredNames('languages', languages, target.expectation.requiredLanguages),
    scoreRequiredNames('frameworks', frameworks, target.expectation.requiredFrameworks)
  ];

  if (graphIntegrity) {
    const graphScore = normalizedScore(graphIntegrity.relationship_coverage_score);
    const danglingRatio = ratio(graphIntegrity.total_edges - graphIntegrity.dangling_edges, graphIntegrity.total_edges);
    gates.push(gate(
      'graph-integrity',
      graphScore >= 80 && danglingRatio >= 0.95 ? 'pass' : graphScore >= 50 && danglingRatio >= 0.8 ? 'warn' : 'fail',
      Math.min(graphScore, danglingRatio * 100),
      `${graphIntegrity.connected_nodes} connected, ${graphIntegrity.orphaned_nodes} orphaned, ${graphIntegrity.dangling_edges} dangling`
    ));
    gates.push(gate(
      'entry-handler-coverage',
      entryPoints.length === 0 || graphIntegrity.entry_points_with_handlers === entryPoints.length ? 'pass' : 'warn',
      ratio(graphIntegrity.entry_points_with_handlers, entryPoints.length) * 100,
      `${graphIntegrity.entry_points_with_handlers}/${entryPoints.length}`
    ));
    gates.push(gate(
      'exit-source-coverage',
      exitPoints.length === 0 || graphIntegrity.exit_points_with_sources === exitPoints.length ? 'pass' : 'warn',
      ratio(graphIntegrity.exit_points_with_sources, exitPoints.length) * 100,
      `${graphIntegrity.exit_points_with_sources}/${exitPoints.length}`
    ));
    gates.push(gate(
      'facts-with-evidence',
      facts === 0 || graphIntegrity.facts_with_evidence === facts ? 'pass' : 'warn',
      ratio(graphIntegrity.facts_with_evidence, facts) * 100,
      `${graphIntegrity.facts_with_evidence}/${facts}`
    ));
  } else {
    gates.push(gate('graph-integrity', 'fail', 0, 'Missing validation.graph_integrity'));
  }

  const score = Math.round(gates.reduce((sum, result) => sum + result.score, 0) / gates.length);
  const status: GateStatus = gates.some(result => result.status === 'fail')
    ? 'fail'
    : gates.some(result => result.status === 'warn') ? 'warn' : 'pass';
  const topGaps = gates
    .filter(result => result.status !== 'pass')
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .map(result => `${result.id}: ${result.detail}`);

  return {
    name: target.name,
    path: target.path,
    status,
    score,
    durationMs,
    summary: {
      nodes: output.nodes.length,
      edges: output.edges.length,
      entryPoints: entryPoints.length,
      exitPoints: exitPoints.length,
      methodCalls,
      callChains,
      facts,
      analysisErrors,
      frameworks,
      languages
    },
    gates,
    topGaps
  };
}

async function analyzeTarget(target: RepoTarget): Promise<TargetReport> {
  const startedAt = Date.now();
  const output = await getOrchestrator().orchestrateAnalysis(target.path);
  return scoreCas(output, target, Date.now() - startedAt);
}

function aggregateStatus(reports: TargetReport[]): GateStatus {
  if (reports.some(report => report.status === 'fail')) return 'fail';
  if (reports.some(report => report.status === 'warn')) return 'warn';
  return 'pass';
}

function printReport(report: GauntletReport): void {
  console.log(`Golden repo gauntlet: ${report.status.toUpperCase()} (${report.score}/100)`);
  for (const target of report.targets) {
    console.log([
      `${target.status.toUpperCase().padEnd(4)} ${String(target.score).padStart(3)}/100`,
      target.name,
      `${target.summary.nodes} nodes`,
      `${target.summary.edges} edges`,
      `${target.summary.entryPoints} entries`,
      `${target.summary.methodCalls} calls`,
      `${Math.round(target.durationMs / 1000)}s`
    ].join(' | '));
    if (target.topGaps.length > 0) {
      for (const gap of target.topGaps) {
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
    throw new Error(`No gauntlet targets found under ${args.devRoot}`);
  }

  if (args.dryRun) {
    for (const target of targets) {
      console.log(`${target.name}: ${target.path}`);
    }
    return;
  }

  const targetReports: TargetReport[] = [];
  for (const target of targets) {
    console.log(`Analyzing ${target.name}: ${target.path}`);
    targetReports.push(await analyzeTarget(target));
  }

  const status = aggregateStatus(targetReports);
  const score = Math.round(targetReports.reduce((sum, target) => sum + target.score, 0) / targetReports.length);
  const report: GauntletReport = {
    generatedAt: new Date().toISOString(),
    status,
    score,
    targets: targetReports
  };

  await fs.ensureDir(path.dirname(args.outputPath));
  await fs.writeJson(args.outputPath, report, { spaces: 2 });
  printReport(report);
  console.log(`Report: ${args.outputPath}`);

  if (status === 'fail' || (status === 'warn' && args.failOnWarn)) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export {
  discoverTargets,
  scoreCas,
  analyzeTarget,
  type GauntletReport,
  type TargetReport,
  type RepoTarget
};
