
















import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import type { CASOutput, CASCoverageGap } from '../../../../packages/analyzer-core/src/types/cas.types';

const MANIFEST_NAMES = [
  'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'composer.json',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'mix.exs',
  'CMakeLists.txt', 'Package.swift',
];

const SKIP_DIR_NAMES = new Set([
  'node_modules', 'target', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt',
  '.turbo', '.cache', '.vite', 'vendor', 'vendors', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', '.venv', 'venv', '.tox', '.dart_tool', '.gradle',
  'Pods', '.klauro', 'google-cloud-sdk',
]);

interface DiscoveredEntry {
  dirPath: string;
  name: string;
}

async function manifestsIn(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }



  return entries.filter(e => MANIFEST_NAMES.includes(e) || e.endsWith('.sln') || e.endsWith('.csproj'));
}

async function discover(root: string, maxDepth = 3, maxProjects = 40): Promise<DiscoveredEntry[]> {
  const projects: DiscoveredEntry[] = [];


  const skipNames = new Set((process.env.COVERAGE_SWEEP_SKIP || '').split(',').map(s => s.trim()).filter(Boolean));

  async function walk(dir: string, depth: number): Promise<void> {
    if (projects.length >= maxProjects) return;
    if (depth > maxDepth) return;
    let subEntries: fs.Dirent[];
    try {
      subEntries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const manifests = await manifestsIn(dir);
    if (manifests.length > 0) {
      projects.push({ dirPath: dir, name: path.basename(dir) });
      return;
    }
    const subDirs = subEntries.filter(
      e => e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIR_NAMES.has(e.name) && !skipNames.has(e.name) && !e.name.startsWith('.')
    );
    for (const sd of subDirs) {
      if (projects.length >= maxProjects) return;
      await walk(path.join(dir, sd.name), depth + 1);
    }
  }

  await walk(root, 0);
  return projects;
}

interface RepoResult {
  name: string;
  dirPath: string;
  crashed: boolean;
  error?: string;
  timeMs?: number;
  nodeCount?: number;
  codebaseType?: string;
  codebaseTypeConfidence?: number;
  codebaseTypes?: Array<{ type: string; confidence: number }>;
  entryPointCount?: number;
  gaps?: CASCoverageGap[];


  depth?: RepoDepthCapture;
}



interface RepoDepthCapture {

  seams: { sync: number; async: number; passive: number; total: number } | null;

  consistency: {
    passive_replica: number;
    passive_streaming: number;
    strong_stores: number;
    eventual_stores: number;
    tunable_stores: number;
    store_consistency: number;
  } | null;

  topology: { deployables: number; edge_count: number } | null;

  ci: { pipelines: number; jobs: number };


  analyzer_nodes: Record<string, number>;

  errors: Array<{ analyzer?: string; severity: string; code: string; message: string }>;
  test_suites: number;
  exit_points: number;
  external_services: number;
}

function captureDepth(cas: CASOutput): RepoDepthCapture {
  const nodes = cas.nodes || [];
  const countType = (type: string) => nodes.filter(n => n.type === type).length;
  const seamCounts = cas.communication_seams?.inventory?.counts;
  const cons = (cas as any).consistency_model;
  const topology = (cas.product_map as any)?.runtime_topology;
  const analyzerNodes: Record<string, number> = {};
  for (const c of cas.analyzer_contributions || []) {
    analyzerNodes[c.analyzer_id || c.analyzer_name] = c.nodes_created ?? 0;
  }
  return {
    seams: seamCounts
      ? { sync: seamCounts.sync, async: seamCounts.async, passive: seamCounts.passive, total: seamCounts.total }
      : null,
    consistency: cons
      ? { ...cons.counts, store_consistency: cons.store_consistency?.length ?? 0 }
      : null,
    topology: topology
      ? { deployables: topology.deployables?.length ?? 0, edge_count: topology.edge_count ?? 0 }
      : null,
    ci: { pipelines: countType('ci_pipeline'), jobs: countType('ci_job') },
    analyzer_nodes: analyzerNodes,
    errors: (cas.analysis_errors || []).map(e => ({
      analyzer: e.analyzer, severity: e.severity, code: e.code, message: (e.message || '').slice(0, 200),
    })),
    test_suites: cas.test_suites?.length ?? 0,
    exit_points: cas.exit_points?.length ?? 0,
    external_services: (cas as any).external_services?.length ?? 0,
  };
}

const PER_REPO_TIMEOUT_MS = Number(process.env.COVERAGE_SWEEP_PER_REPO_TIMEOUT_MS || '120000');

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms analyzing ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function analyzeOne(entry: DiscoveredEntry): Promise<RepoResult> {
  const start = Date.now();
  try {
    const cas: CASOutput = await withTimeout(analyzeForBench(entry.dirPath), PER_REPO_TIMEOUT_MS, entry.name);
    return {
      name: entry.name,
      dirPath: entry.dirPath,
      crashed: false,
      timeMs: Date.now() - start,
      nodeCount: cas.nodes?.length ?? 0,
      codebaseType: cas.codebase_type,
      codebaseTypeConfidence: cas.codebase_type_confidence,
      codebaseTypes: cas.codebase_types,
      entryPointCount: cas.entry_points?.length ?? 0,
      gaps: cas.coverage_gaps ?? [],
      depth: captureDepth(cas),
    };
  } catch (error) {
    return {
      name: entry.name,
      dirPath: entry.dirPath,
      crashed: true,
      error: error instanceof Error ? error.message : String(error),
      timeMs: Date.now() - start,
    };
  }
}

function aggregateGapCounts(results: RepoResult[], kind: CASCoverageGap['kind']): Array<{ key: string; count: number; repos: string[] }> {
  const byKey = new Map<string, { count: number; repos: Set<string> }>();
  for (const r of results) {
    for (const g of r.gaps ?? []) {
      if (g.kind !== kind) continue;
      const key = g.key ?? g.evidence;
      const entry = byKey.get(key) ?? { count: 0, repos: new Set<string>() };
      entry.count += 1;
      entry.repos.add(r.name);
      byKey.set(key, entry);
    }
  }
  return [...byKey.entries()]
    .map(([key, v]) => ({ key, count: v.count, repos: [...v.repos] }))
    .sort((a, b) => b.count - a.count);
}

function renderMarkdown(results: RepoResult[]): string {
  const ok = results.filter(r => !r.crashed);
  const crashed = results.filter(r => r.crashed);

  const byType = new Map<string, number>();
  for (const r of ok) {
    const t = r.codebaseType ?? 'unknown';
    byType.set(t, (byType.get(t) || 0) + 1);
  }
  const typeRows = [...byType.entries()].sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `| ${type} | ${count} |`).join('\n');

  const unknownDeps = aggregateGapCounts(ok, 'unknown-dependency').slice(0, 30);
  const lowExtraction = aggregateGapCounts(ok, 'low-extraction-ratio').slice(0, 20);
  const zeroEntry = aggregateGapCounts(ok, 'zero-entry-points').slice(0, 20);
  const unhandledNodeTypes = aggregateGapCounts(ok, 'unhandled-node-type').slice(0, 20);

  const perRepoRows = ok.map(r => {
    const gapCounts = { 'unknown-dependency': 0, 'low-extraction-ratio': 0, 'zero-entry-points': 0, 'unhandled-node-type': 0 } as Record<string, number>;
    for (const g of r.gaps ?? []) gapCounts[g.kind] = (gapCounts[g.kind] || 0) + 1;
    return `| ${r.name} | ${r.codebaseType ?? 'unknown'} | ${(r.codebaseTypeConfidence ?? 0).toFixed(2)} | ${r.nodeCount ?? 0} | ${r.entryPointCount ?? 0} | ${gapCounts['unknown-dependency']} | ${gapCounts['low-extraction-ratio']} | ${gapCounts['zero-entry-points']} | ${gapCounts['unhandled-node-type']} |`;
  }).join('\n');

  return `# Coverage Intelligence Report

Generated ${new Date().toISOString()}. Empirical sweep of ${results.length} real ~/dev repos
(${ok.length} analyzed successfully, ${crashed.length} crashed) using the engine's codebase-TYPE
classification + coverage-gap self-discovery layer (see
\`packages/analyzer-core/src/analyzer/core/coverage-gaps.ts\`).

This is the empirical backlog: which unknown deps/frameworks recur most, which
types have zero-entry-point repos, which tree-sitter node types are most
unhandled. Drives the next fix waves.

## Codebase TYPE distribution

| Type | Repo count |
| --- | --- |
${typeRows}

## Top recurring unknown dependencies (no analyzer recognizes them)

| Dependency | Repos affected | Occurrences |
| --- | --- | --- |
${unknownDeps.map(d => `| ${d.key} | ${d.repos.length} | ${d.count} |`).join('\n') || '| _(none found)_ | | |'}

## Top low-extraction-ratio file extensions (parsed but nearly nothing extracted)

| Extension | Repos affected | Occurrences |
| --- | --- | --- |
${lowExtraction.map(d => `| ${d.key} | ${d.repos.length} | ${d.count} |`).join('\n') || '| _(none found)_ | | |'}

## Zero-entry-point repos by codebase_type (missing entry-point model for this type)

| codebase_type | Repos affected | Occurrences |
| --- | --- | --- |
${zeroEntry.map(d => `| ${d.key} | ${d.repos.length} | ${d.count} |`).join('\n') || '| _(none found)_ | | |'}

## Top unhandled tree-sitter node types

| Node type | Repos affected | Occurrences |
| --- | --- | --- |
${unhandledNodeTypes.map(d => `| ${d.key} | ${d.repos.length} | ${d.count} |`).join('\n') || '| _(none found — no per-node-type walker instrumentation wired into this sweep\'s analyzer pass yet)_ | | |'}

## Per-repo detail

| Repo | codebase_type | confidence | nodes | entry points | unknown-deps | low-extraction | zero-entry | unhandled-node-type |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${perRepoRows}

${crashed.length > 0 ? `## Crashed (${crashed.length})\n\n${crashed.map(r => `- ${r.name}: ${r.error}`).join('\n')}\n` : ''}
`;
}

async function main() {
  const root = process.env.COVERAGE_SWEEP_ROOT || path.join(os.homedir(), 'dev');
  const maxProjects = Number(process.env.COVERAGE_SWEEP_MAX_PROJECTS || '40');




  const depthMode = process.env.COVERAGE_SWEEP_DEPTH === '1';
  const statePath = process.env.COVERAGE_SWEEP_STATE || path.join(os.tmpdir(), 'corpus-depth-sweep-state.json');

  console.error(`[coverage-intel-sweep] discovering projects under ${root} (max ${maxProjects})...`);
  const entries = await discover(root, 3, maxProjects);
  console.error(`[coverage-intel-sweep] discovered ${entries.length} projects. Analyzing...`);

  const results: RepoResult[] = [];
  const done = new Set<string>();
  if (depthMode && await fs.pathExists(statePath)) {
    const prior: RepoResult[] = await fs.readJson(statePath);
    for (const r of prior) { results.push(r); done.add(r.dirPath); }
    console.error(`[coverage-intel-sweep] resuming: ${results.length} repos already captured in ${statePath}`);
  }

  for (const entry of entries) {
    if (done.has(entry.dirPath)) continue;
    const r = await analyzeOne(entry);
    results.push(r);
    console.error(`[coverage-intel-sweep] ${r.crashed ? 'CRASH' : 'ok'} ${r.name} (${r.timeMs}ms)${r.crashed ? ` — ${r.error}` : ` type=${r.codebaseType} gaps=${r.gaps?.length ?? 0}`}`);
    if (depthMode) await fs.writeJson(statePath, results, { spaces: 0 });
  }

  if (depthMode) {
    console.error(`[coverage-intel-sweep] depth mode: raw results at ${statePath} (${results.length} repos)`);
    return;
  }

  const md = renderMarkdown(results);
  const outPath = path.join(__dirname, '..', '..', '..', '..', 'docs', 'COVERAGE-INTELLIGENCE.md');
  await fs.ensureDir(path.dirname(outPath));
  await fs.writeFile(outPath, md, 'utf8');
  console.error(`[coverage-intel-sweep] wrote ${outPath}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export { discover, analyzeOne, renderMarkdown };
