import * as fs from 'fs-extra';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createOrchestrator, type IncrementalAnalysisResult } from './analyzer';
import { buildCrossCodebaseSystemGraph, type CrossCodebaseSystemGraph } from './cross-codebase-analysis';
import { compareCasGraphs } from './incremental-graph-equivalence';
import { buildIncrementalCrossCodebaseSystemGraph } from './incremental-workspace-analysis';
import { isDirectCliInvocation } from './cli-invocation';

type LocalityScope = 'single-symbol' | 'file' | 'package' | 'deployable' | 'cross-repository';

interface LocalityMeasurement {
  scope: LocalityScope;
  status: 'pass' | 'fail';
  incremental_ms: number;
  cold_ms: number;
  speedup_vs_cold: number;
  graph_equivalent: boolean;
  strategy: string;
  direct_changed_files: number;
  analyzed_files: number;
  tracked_files: number;
  reused_files: number;
  reuse_ratio: number;
  affected_package_roots: string[];
  affected_deployable_roots: string[];
  changed_members: string[];
  reused_members: string[];
  assertions: Record<string, boolean>;
  difference?: string;
}

export interface IncrementalLocalityBenchmarkReport {
  benchmark_type: 'incremental-edit-locality';
  generated_at: string;
  status: 'pass' | 'fail';
  score: number;
  summary: {
    scope_count: number;
    scopes_passed: number;
    graph_equivalence_rate: number;
    average_reuse_ratio: number;
    average_speedup_vs_cold: number;
  };
  scopes: LocalityMeasurement[];
}

interface BenchmarkOptions {
  outputPath?: string;
  markdownPath?: string;
  keepWorkspace?: boolean;
}

export async function runIncrementalLocalityBenchmark(
  options: BenchmarkOptions = {}
): Promise<IncrementalLocalityBenchmarkReport> {
  const benchmark = await createBenchmarkWorkspace();
  try {
    const scopes = [
      await measureRepositoryScope(benchmark.source, 'single-symbol', async workspace => {
        await replaceText(workspace, 'src/catalog.ts', 'return value.trim();', 'return value.trim().toUpperCase();');
      }),
      await measureRepositoryScope(benchmark.source, 'file', async workspace => {
        await fs.outputFile(path.join(workspace, 'src', 'validation.ts'), 'export function hasValue(value: string): boolean { return value.length > 0; }\n');
      }),
      await measureRepositoryScope(benchmark.source, 'package', async workspace => {
        await replaceText(workspace, 'packages/core/src/index.ts', 'return `record:${id}`;', 'return `record:${id.trim()}`;');
      }),
      await measureRepositoryScope(benchmark.source, 'deployable', async workspace => {
        await replaceText(workspace, 'services/api/src/server.ts', 'return formatRecord(id);', 'return formatRecord(id.trim());');
      }),
      await measureCrossRepositoryScope(benchmark.source)
    ];
    const scopesPassed = scopes.filter(scope => scope.status === 'pass').length;
    const report: IncrementalLocalityBenchmarkReport = {
      benchmark_type: 'incremental-edit-locality',
      generated_at: new Date().toISOString(),
      status: scopesPassed === scopes.length ? 'pass' : 'fail',
      score: Math.round((scopesPassed / scopes.length) * 100),
      summary: {
        scope_count: scopes.length,
        scopes_passed: scopesPassed,
        graph_equivalence_rate: round(scopes.filter(scope => scope.graph_equivalent).length / scopes.length),
        average_reuse_ratio: round(average(scopes.map(scope => scope.reuse_ratio))),
        average_speedup_vs_cold: round(average(scopes.map(scope => scope.speedup_vs_cold)))
      },
      scopes
    };
    await writeReport(report, options);
    return report;
  } finally {
    if (!options.keepWorkspace) await fs.remove(benchmark.root);
  }
}

async function measureRepositoryScope(
  source: string,
  scope: Exclude<LocalityScope, 'cross-repository'>,
  edit: (workspace: string) => Promise<void>
): Promise<LocalityMeasurement> {
  const workspace = await copyBenchmarkWorkspace(source, scope);
  const orchestrator = createOrchestrator();
  const baseline = await orchestrator.orchestrateAnalysis(workspace);
  const state = orchestrator.createIncrementalBaseline(workspace, baseline);
  await edit(workspace);
  const incremental = await timed(() => createOrchestrator().orchestrateIncrementalAnalysis(workspace, baseline, state));
  const cold = await timed(() => createOrchestrator().orchestrateAnalysis(workspace));
  const parity = compareCasGraphs(incremental.value.output, cold.value);
  const locality = incremental.value.changeReport.locality;
  const assertions = repositoryAssertions(scope, incremental.value, parity.graph_equivalent);
  return {
    scope,
    status: Object.values(assertions).every(Boolean) ? 'pass' : 'fail',
    incremental_ms: incremental.ms,
    cold_ms: cold.ms,
    speedup_vs_cold: ratio(cold.ms, incremental.ms),
    graph_equivalent: parity.graph_equivalent,
    strategy: locality?.strategy || 'missing',
    direct_changed_files: locality?.directChangedFiles || 0,
    analyzed_files: locality?.analyzedFiles || 0,
    tracked_files: locality?.trackedFiles || 0,
    reused_files: locality?.reusedFiles || 0,
    reuse_ratio: locality?.reuseRatio || 0,
    affected_package_roots: locality?.affectedPackageRoots || [],
    affected_deployable_roots: locality?.affectedDeployableRoots || [],
    changed_members: [],
    reused_members: [],
    assertions
  };
}

function repositoryAssertions(
  scope: Exclude<LocalityScope, 'cross-repository'>,
  result: IncrementalAnalysisResult,
  graphEquivalent: boolean
): Record<string, boolean> {
  const locality = result.changeReport.locality;
  return {
    edit_stayed_incremental: !result.wasFullRebuild,
    unchanged_files_reused: Boolean(locality && locality.reusedFiles > 0 && locality.reuseRatio > 0),
    changed_scope_analyzed: Boolean(locality && locality.directChangedFiles === 1 && locality.analyzedFiles > 0),
    package_boundary_attributed: scope !== 'package' || Boolean(locality?.affectedPackageRoots?.includes('packages/core')),
    deployable_boundary_attributed: scope !== 'deployable' || Boolean(locality?.affectedDeployableRoots?.includes('services/api')),
    cold_graph_equivalent: graphEquivalent
  };
}

async function measureCrossRepositoryScope(source: string): Promise<LocalityMeasurement> {
  const workspace = await copyBenchmarkWorkspace(source, 'cross-repository');
  const memberA = path.join(workspace, 'members', 'producer');
  const memberB = path.join(workspace, 'members', 'consumer');
  const orchestratorA = createOrchestrator();
  const baselineA = await orchestratorA.orchestrateAnalysis(memberA);
  const stateA = orchestratorA.createIncrementalBaseline(memberA, baselineA);
  const baselineB = await createOrchestrator().orchestrateAnalysis(memberB);
  const repositories = [{ path: memberA, cas: baselineA }, { path: memberB, cas: baselineB }];
  const graphOptions = { id: 'locality-workspace', generatedAt: '2026-01-01T00:00:00.000Z' };
  const previous = buildIncrementalCrossCodebaseSystemGraph({
    name: 'locality-workspace', repositories, ...graphOptions
  });
  await replaceText(memberA, 'src/index.ts', 'return value;', 'return value.trim();');
  const memberIncremental = await createOrchestrator().orchestrateIncrementalAnalysis(memberA, baselineA, stateA);
  const incremental = await timed(async () => buildIncrementalCrossCodebaseSystemGraph({
    name: 'locality-workspace',
    repositories: [{ path: memberA, cas: memberIncremental.output }, { path: memberB, cas: baselineB }],
    previous,
    ...graphOptions
  }));
  const coldMember = await createOrchestrator().orchestrateAnalysis(memberA);
  const cold = await timed(async () => buildCrossCodebaseSystemGraph(
    'locality-workspace',
    [{ path: memberA, cas: coldMember }, { path: memberB, cas: baselineB }],
    graphOptions
  ));
  const comparison = compareCrossRepositoryGraphs(incremental.value, cold.value);
  const memberGraphEquivalent = compareCasGraphs(memberIncremental.output, coldMember).graph_equivalent;
  const locality = incremental.value.incremental_locality;
  const assertions = {
    one_member_changed: locality.changedMembers.length === 1 && locality.changedMembers[0] === memberA,
    one_member_reused: locality.reusedMembers.length === 1 && locality.reusedMembers[0] === memberB,
    unchanged_member_analysis_reused: locality.reuseRatio === 0.5,
    changed_member_stayed_incremental: !memberIncremental.wasFullRebuild,
    changed_member_cold_graph_equivalent: memberGraphEquivalent,
    cold_graph_equivalent: comparison.equal
  };
  return {
    scope: 'cross-repository',
    status: Object.values(assertions).every(Boolean) ? 'pass' : 'fail',
    incremental_ms: incremental.ms,
    cold_ms: cold.ms,
    speedup_vs_cold: ratio(cold.ms, incremental.ms),
    graph_equivalent: comparison.equal,
    strategy: locality.strategy,
    direct_changed_files: memberIncremental.changeReport.locality?.directChangedFiles || 0,
    analyzed_files: memberIncremental.changeReport.locality?.analyzedFiles || 0,
    tracked_files: memberIncremental.changeReport.locality?.trackedFiles || 0,
    reused_files: memberIncremental.changeReport.locality?.reusedFiles || 0,
    reuse_ratio: locality.reuseRatio,
    affected_package_roots: memberIncremental.changeReport.locality?.affectedPackageRoots || [],
    affected_deployable_roots: memberIncremental.changeReport.locality?.affectedDeployableRoots || [],
    changed_members: locality.changedMembers,
    reused_members: locality.reusedMembers,
    assertions,
    difference: comparison.difference
  };
}

function compareCrossRepositoryGraphs(
  incremental: CrossCodebaseSystemGraph & { incremental_locality?: unknown },
  cold: CrossCodebaseSystemGraph
): { equal: boolean; difference?: string } {
  const incrementalComparable = comparableWorkspaceGraph(incremental);
  const coldComparable = comparableWorkspaceGraph(cold);
  const difference = firstDifference(incrementalComparable, coldComparable);
  return { equal: !difference, difference };
}

function comparableWorkspaceGraph(graph: CrossCodebaseSystemGraph & { incremental_locality?: unknown }): unknown {
  return JSON.parse(JSON.stringify(graph), (key, value) => {
    if (key === 'incremental_locality') return undefined;
    if (key === 'analysis_id' || key === 'analysis_timestamp') return undefined;
    if (key === 'cas_analysis_id' || key === 'cas_generated_at') return undefined;
    if (key === 'generated_at' || key === 'started_at' || key === 'completed_at') return undefined;
    if (key === 'duration_ms' || key === 'execution_time_ms' || key === 'timings') return undefined;
    return value;
  });
}

function firstDifference(left: unknown, right: unknown, location = '$'): string | undefined {
  if (Object.is(left, right)) return undefined;
  if (typeof left !== typeof right || left === null || right === null) {
    return `${location}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`;
  }
  if (typeof left !== 'object') return `${location}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort();
  for (const key of keys) {
    if (!(key in leftRecord) || !(key in rightRecord)) {
      return `${location}.${key}: ${JSON.stringify(leftRecord[key])} != ${JSON.stringify(rightRecord[key])}`;
    }
    const difference = firstDifference(leftRecord[key], rightRecord[key], `${location}.${key}`);
    if (difference) return difference;
  }
  return undefined;
}

async function createBenchmarkWorkspace(): Promise<{ root: string; source: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-locality-benchmark-'));
  const source = path.join(root, 'source');
  await fs.outputJson(path.join(source, 'package.json'), {
    name: 'locality-benchmark',
    private: true,
    workspaces: ['packages/*', 'services/*']
  });
  await fs.outputFile(path.join(source, 'src', 'catalog.ts'), 'export function normalizeValue(value: string): string { return value.trim(); }\n');
  await fs.outputJson(path.join(source, 'packages', 'core', 'package.json'), { name: '@local/core', version: '1.0.0' });
  await fs.outputFile(path.join(source, 'packages', 'core', 'src', 'index.ts'), 'export function formatRecord(id: string): string { return `record:${id}`; }\n');
  await fs.outputJson(path.join(source, 'services', 'api', 'package.json'), {
    name: '@local/api', version: '1.0.0', dependencies: { '@local/core': 'workspace:*' }
  });
  await fs.outputFile(path.join(source, 'services', 'api', 'Dockerfile'), 'FROM node:22-alpine\nCOPY . .\nCMD ["node", "dist/server.js"]\n');
  await fs.outputFile(path.join(source, 'services', 'api', 'src', 'server.ts'), 'import { formatRecord } from "@local/core";\nexport function recordResponse(id: string): string { return formatRecord(id); }\n');
  await fs.outputJson(path.join(source, 'members', 'producer', 'package.json'), { name: 'producer', version: '1.0.0' });
  await fs.outputFile(path.join(source, 'members', 'producer', 'src', 'index.ts'), 'export function produce(value: string): string { return value; }\n');
  await fs.outputJson(path.join(source, 'members', 'consumer', 'package.json'), { name: 'consumer', version: '1.0.0' });
  await fs.outputFile(path.join(source, 'members', 'consumer', 'src', 'index.ts'), 'export function consume(value: string): number { return value.length; }\n');
  return { root, source };
}

async function copyBenchmarkWorkspace(source: string, scope: string): Promise<string> {
  const target = path.join(path.dirname(source), 'scopes', scope);
  await fs.copy(source, target);
  return target;
}

async function replaceText(workspace: string, relativePath: string, from: string, to: string): Promise<void> {
  const file = path.join(workspace, relativePath);
  const source = await fs.readFile(file, 'utf8');
  if (!source.includes(from)) throw new Error(`Benchmark edit target is missing from ${relativePath}`);
  await fs.writeFile(file, source.replace(from, to));
}

async function timed<T>(operation: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await operation();
  return { value, ms: Math.max(0.01, round(performance.now() - started)) };
}

async function writeReport(report: IncrementalLocalityBenchmarkReport, options: BenchmarkOptions): Promise<void> {
  const outputPath = path.resolve(options.outputPath || '.klauro-incremental-locality/latest-report.json');
  const markdownPath = path.resolve(options.markdownPath || '.klauro-incremental-locality/latest-report.md');
  await fs.outputJson(outputPath, report, { spaces: 2 });
  await fs.outputFile(markdownPath, formatIncrementalLocalityMarkdown(report));
}

export function formatIncrementalLocalityMarkdown(report: IncrementalLocalityBenchmarkReport): string {
  const rows = report.scopes.map(scope =>
    `| ${scope.scope} | ${scope.status} | ${scope.incremental_ms} | ${scope.cold_ms} | ${scope.speedup_vs_cold}x | ${(scope.reuse_ratio * 100).toFixed(1)}% | ${scope.graph_equivalent ? 'yes' : 'no'} |`
  );
  return [
    '# Incremental Edit Locality',
    '',
    `Status: ${report.status.toUpperCase()} (${report.score}/100)`,
    '',
    '| Scope | Status | Incremental ms | Cold ms | Speedup | Reuse | Exact parity |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- |',
    ...rows,
    ''
  ].join('\n');
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function ratio(numerator: number, denominator: number): number {
  return round(denominator > 0 ? numerator / denominator : 0);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function parseArgs(argv: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--output') options.outputPath = argv[++index];
    else if (argv[index] === '--markdown') options.markdownPath = argv[++index];
    else if (argv[index] === '--keep-workspace') options.keepWorkspace = true;
  }
  return options;
}

if (isDirectCliInvocation('incremental-locality-benchmark')) {
  runIncrementalLocalityBenchmark(parseArgs(process.argv.slice(2)))
    .then(report => {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.status !== 'pass') process.exitCode = 1;
    })
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
