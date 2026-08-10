/**
 * Corpus sweep: validate the REAL product (blackbox, via analyzeForBench) against
 * the user's actual ~/dev corpus — 100+ real, in-progress, messy repos across
 * several workspaces (personal, soon, zerac, money, clients, ...).
 *
 * This is NOT a fixture bench. It is teeth-cutting: run the product on real code
 * outside any curated corpus, and honestly report where it works vs breaks.
 * SYSTEMATIC failures (repeat across N repos) matter far more than one-offs.
 *
 * BLACKBOX RULE: this file calls analyzeForBench() (./product-analysis.ts) for
 * per-repo CAS and buildCrossCodebaseSystemGraph() (../cross-codebase-analysis.ts,
 * a pure function over already-produced CAS outputs, not an engine internal) for
 * per-workspace CAS composition (workspace-level). It never imports createOrchestrator/orchestrateAnalysis/
 * analyzeProject, and never sets an AI/model env var.
 *
 * Run: npx tsx apps/mcp-server/src/gauntlet/corpus-sweep.ts
 *   CORPUS_SWEEP_ROOT=~/dev           (default)
 *   CORPUS_SWEEP_MAX_PROJECTS=60      (cap on standalone projects; workspaces are
 *                                      always run in addition to the cap)
 *   CORPUS_SWEEP_ONLY_LEADS=1         (skip discovery, run only the 8 lead targets)
 */

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { analyzeForBench } from './product-analysis';
import { buildCrossCodebaseSystemGraph, type CrossCodebaseInput } from '../cross-codebase-analysis';
import type { CASOutput } from '../../../../packages/analyzer-core/src/types/cas.types';

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const MANIFEST_NAMES = [
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'mix.exs',
  'CMakeLists.txt',
  'Package.swift',
];

const CSPROJ_GLOB_SUFFIX = '.csproj';

const SKIP_DIR_NAMES = new Set([
  'node_modules', 'target', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt',
  '.turbo', '.cache', '.vite', 'vendor', 'vendors', '__pycache__', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', '.venv', 'venv', '.tox', '.dart_tool', '.gradle',
  'Pods', '.klauro', 'google-cloud-sdk',
]);

interface DiscoveredEntry {
  dirPath: string;
  name: string;
  manifests: string[];
}

/** True if `dir` directly contains a recognized manifest file. */
async function manifestsIn(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const e of entries) {
    if (MANIFEST_NAMES.includes(e)) found.push(e);
    else if (e.endsWith(CSPROJ_GLOB_SUFFIX)) found.push(e);
  }
  return found;
}

/**
 * Walk `root` looking for PROJECT roots (a dir with a manifest) and WORKSPACE
 * roots (a dir with >=3 direct subdirectories that are themselves project
 * roots). Skips node_modules/target/.git/dist/build and hidden dirs. Does not
 * descend into a directory once it's been classified as a project root
 * (its own sub-manifests, e.g. a monorepo's packages/*, are left to the
 * product's own workspace-detection during analysis, not double-counted here
 * as separate top-level projects) UNLESS that directory is itself a
 * workspace-root candidate (>=3 sub-project manifests) — in which case we
 * still stop there and record it as a workspace, not recurse further.
 */
async function discover(
  root: string,
  maxDepth = 3
): Promise<{ projects: DiscoveredEntry[]; workspaces: DiscoveredEntry[]; scanned: number }> {
  const projects: DiscoveredEntry[] = [];
  const workspaces: DiscoveredEntry[] = [];
  let scanned = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    scanned++;
    if (depth > maxDepth) return;
    let subEntries: fs.Dirent[];
    try {
      subEntries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subDirs = subEntries.filter(
      (e) => e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIR_NAMES.has(e.name) && !e.name.startsWith('.')
    );

    const ownManifests = await manifestsIn(dir);

    // Check how many direct subdirs are themselves project roots (manifest present).
    const subManifestChecks = await Promise.all(
      subDirs.map(async (sd) => ({ sd, manifests: await manifestsIn(path.join(dir, sd.name)) }))
    );
    const subProjectCount = subManifestChecks.filter((c) => c.manifests.length > 0).length;

    if (subProjectCount >= 3) {
      // Workspace root: >=3 sub-project manifests. Record it; do not recurse
      // further (its sub-projects are covered by the workspace-level-CAS run over this workspace).
      workspaces.push({ dirPath: dir, name: path.basename(dir), manifests: ownManifests });
      return;
    }

    if (ownManifests.length > 0) {
      // Project root. Record it; don't recurse into its own tree (avoids
      // double-counting nested workspace packages as separate top-level hits).
      projects.push({ dirPath: dir, name: path.basename(dir), manifests: ownManifests });
      return;
    }

    // Neither: recurse into subdirs looking for project/workspace roots further down.
    for (const sd of subDirs) {
      await walk(path.join(dir, sd.name), depth + 1);
    }
  }

  await walk(root, 0);
  return { projects, workspaces, scanned };
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

interface ProjectResult {
  name: string;
  dirPath: string;
  hasManifest: boolean;
  crashed: boolean;
  error?: string;
  timeMs?: number;
  nodeCount?: number;
  primaryDomain?: string;
  domainSource?: string;
  languages?: string[];
  deployableCount?: number;
  deployableNames?: string[];
  distributionUnitCount?: number;
  entryPointCount?: number;
  routeCount?: number;
  gracefulOnEmpty?: boolean; // only meaningful for no-manifest targets
}

interface WorkspaceResult {
  name: string;
  dirPath: string;
  subRepos: string[];
  crashed: boolean;
  error?: string;
  timeMs?: number;
  deployableCount?: number;
  deployableNames?: string[];
  applicationLinkCount?: number;
  sharedCodeRollupPresent?: boolean;
  sharedCodeRollupLibNames?: string[];
  workspaceDomain?: string;
  subRepoResults: ProjectResult[];
}

// ---------------------------------------------------------------------------
// Per-project / per-workspace analysis
// ---------------------------------------------------------------------------

function casToProjectResult(cas: CASOutput, dirPath: string, name: string, timeMs: number, hasManifest = true): ProjectResult {
  const enhanced = (cas as any).enhanced_system_purpose;
  const deployables = cas.deployable_evidence || [];
  return {
    name,
    dirPath,
    hasManifest,
    crashed: false,
    timeMs,
    nodeCount: cas.nodes?.length ?? 0,
    primaryDomain: enhanced?.primary_domain ?? (cas as any).system_purpose?.primary_domain ?? cas.system?.description,
    domainSource: enhanced?.domain_source,
    languages: (cas.system?.technologies?.languages || []).map((l: any) => l.name).slice(0, 5),
    deployableCount: deployables.length,
    deployableNames: deployables.slice(0, 8).map((d) => d.name),
    distributionUnitCount: cas.distribution_units?.length ?? 0,
    entryPointCount: cas.entry_points?.length ?? 0,
    routeCount: cas.route_table?.length ?? 0,
    gracefulOnEmpty: hasManifest ? undefined : true,
  };
}

async function analyzeProject(dirPath: string, name: string, hasManifest: boolean): Promise<ProjectResult> {
  const start = Date.now();
  try {
    const cas: CASOutput = await analyzeForBench(dirPath);
    return casToProjectResult(cas, dirPath, name, Date.now() - start, hasManifest);
  } catch (err: any) {
    return {
      name,
      dirPath,
      hasManifest,
      crashed: true,
      error: String(err?.message || err).slice(0, 500),
      timeMs: Date.now() - start,
      gracefulOnEmpty: hasManifest ? undefined : false,
    };
  }
}

async function analyzeWorkspace(dirPath: string, name: string, subDirNames: string[]): Promise<WorkspaceResult> {
  const result: WorkspaceResult = {
    name,
    dirPath,
    subRepos: subDirNames,
    crashed: false,
    subRepoResults: [],
  };
  const start = Date.now();
  try {
    const repositories: CrossCodebaseInput[] = [];
    // Analyze each sub-repo once via the blackbox product call, capturing both
    // the per-repo CAS metrics (for the report) and the CAS itself (to fuse
    // into the workspace-level CAS graph) from the same call — no redundant re-analysis.
    for (const sub of subDirNames) {
      const repoPath = path.join(dirPath, sub);
      const projStart = Date.now();
      try {
        const cas: any = await analyzeForBench(repoPath);
        const projResult = casToProjectResult(cas, repoPath, sub, Date.now() - projStart);
        result.subRepoResults.push(projResult);
        repositories.push({ path: repoPath, name: sub, cas });
      } catch (err: any) {
        result.subRepoResults.push({
          name: sub,
          dirPath: repoPath,
          hasManifest: true,
          crashed: true,
          error: String(err?.message || err).slice(0, 500),
          timeMs: Date.now() - projStart,
        });
      }
    }
    if (repositories.length === 0) {
      throw new Error('no sub-repo analyzed successfully; cannot build workspace graph');
    }
    const graph = buildCrossCodebaseSystemGraph(name, repositories);
    result.timeMs = Date.now() - start;
    result.deployableCount = graph.deployables?.length ?? 0;
    result.deployableNames = (graph.deployables || []).slice(0, 10).map((d: any) => d.name);
    result.applicationLinkCount = graph.application_links?.length ?? 0;
    result.sharedCodeRollupPresent = Boolean(graph.shared_code_rollup && graph.shared_code_rollup.length > 0);
    result.sharedCodeRollupLibNames = (graph.shared_code_rollup || []).slice(0, 10).map((r) => r.lib_name);
    result.workspaceDomain = (graph.workspace_narrative as any)?.primary_domain || (graph as any).workspace_domains?.[0]?.name;
  } catch (err: any) {
    result.crashed = true;
    result.error = String(err?.message || err).slice(0, 500);
    result.timeMs = Date.now() - start;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main sweep
// ---------------------------------------------------------------------------

const LEAD_PROJECTS = [
  '~/dev/personal/kadra.ai',
  '~/dev/personal/kontinuum', // single-repo WITH a root Dockerfile — must not have root dropped
  '~/dev/personal/cleanmusic',
  '~/dev/clients/outcode/hoggan', // no manifest — graceful-handling stress test
  '~/dev/clients/outcode/truckspy', // PHP+JS
  '~/dev/unravl/proof-of-concept', // Klauro's own 14GB self-repo — the exact target that OOM'd the driver in the 2026-07-03/04 re-validation; keep it as a standing large-repo/heap-guard regression check
  '~/dev/openclaw', // second largest corpus repo (76k+ nodes) — large-repo heap-guard cross-check alongside the self-repo
  // v1.0.13 monorepo-scope leads: Nx / pnpm-workspace backends with Dockerfile-only
  // cicd dirs alongside real app packages — the exact isPackageBoundaryManifest case.
  '~/dev/zerac/zerac-ui', // Nx monorepo (nx.json), apps/user-ui + apps/admin-ui, no Dockerfiles
  '~/dev/soon/soon-bos', // pnpm workspace, apps/* each with own package.json + Dockerfile
  '~/dev/soon/finance-context-ts', // pnpm workspace, cicd/api-external + cicd/scheduler are Dockerfile-ONLY dirs (no package.json) alongside apps/* and packages/*
  '~/dev/soon/soon-link', // pnpm workspace, packages/frontend + packages/backend each with own Dockerfile
].map(expandHome);

const LEAD_WORKSPACES = ['~/dev/personal/money', '~/dev/zerac', '~/dev/soon'].map(expandHome);

function expandHome(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

async function subDirsWithManifest(dir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink() || SKIP_DIR_NAMES.has(e.name) || e.name.startsWith('.')) continue;
    const manifests = await manifestsIn(path.join(dir, e.name));
    if (manifests.length > 0) out.push(e.name);
  }
  return out;
}

export interface SweepReport {
  root: string;
  projectResults: ProjectResult[];
  workspaceResults: WorkspaceResult[];
  discoveredProjectCount: number;
  discoveredWorkspaceCount: number;
  cappedProjectCount: number;
  onlyLeads: boolean;
}

async function main() {
  const root = expandHome(process.env.CORPUS_SWEEP_ROOT || '~/dev');
  const maxProjects = Number(process.env.CORPUS_SWEEP_MAX_PROJECTS || 60);
  const onlyLeads = process.env.CORPUS_SWEEP_ONLY_LEADS === '1';
  // CORPUS_SWEEP_EXCLUDE: comma-separated path substrings — any lead or
  // discovered target whose resolved path contains one is skipped (logged, not
  // silent). Lets a sweep honor "avoid these workspaces" mandates without
  // editing the lead lists.
  const excludes = (process.env.CORPUS_SWEEP_EXCLUDE || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const isExcluded = (dir: string) => {
    const p = path.resolve(expandHome(dir)).toLowerCase();
    const hit = excludes.find((e) => p.includes(e));
    if (hit) console.error(`[corpus-sweep] EXCLUDED (${hit}): ${dir}`);
    return Boolean(hit);
  };

  const projectResults: ProjectResult[] = [];
  const workspaceResults: WorkspaceResult[] = [];

  console.error(`[corpus-sweep] root=${root} maxProjects=${maxProjects} onlyLeads=${onlyLeads}${excludes.length ? ` exclude=${excludes.join(',')}` : ''}`);

  // ---- Lead smoke test first (priority targets) ----
  console.error('[corpus-sweep] === LEAD SMOKE TEST ===');
  for (const dir of LEAD_PROJECTS.filter((d) => !isExcluded(d))) {
    const exists = await fs.pathExists(dir);
    if (!exists) {
      console.error(`[corpus-sweep] LEAD MISSING: ${dir}`);
      continue;
    }
    const manifests = await manifestsIn(dir);
    console.error(`[corpus-sweep] lead project: ${dir} (manifests=${manifests.join(',') || 'NONE'})`);
    const t0 = Date.now();
    const r = await analyzeProject(dir, path.basename(dir), manifests.length > 0);
    console.error(
      `[corpus-sweep]   -> crashed=${r.crashed} nodes=${r.nodeCount ?? '-'} domain=${r.primaryDomain ?? '-'} deployables=${r.deployableCount ?? '-'} entryPoints=${r.entryPointCount ?? '-'} routes=${r.routeCount ?? '-'} time=${Date.now() - t0}ms`
    );
    projectResults.push(r);
  }

  for (const dir of LEAD_WORKSPACES.filter((d) => !isExcluded(d))) {
    const exists = await fs.pathExists(dir);
    if (!exists) {
      console.error(`[corpus-sweep] LEAD WORKSPACE MISSING: ${dir}`);
      continue;
    }
    const subs = await subDirsWithManifest(dir);
    console.error(`[corpus-sweep] lead workspace: ${dir} (${subs.length} sub-repos: ${subs.slice(0, 10).join(', ')}${subs.length > 10 ? ', ...' : ''})`);
    if (subs.length === 0) {
      console.error(`[corpus-sweep]   -> SKIP: no sub-repos with manifests found`);
      continue;
    }
    const t0 = Date.now();
    const r = await analyzeWorkspace(dir, path.basename(dir), subs);
    console.error(
      `[corpus-sweep]   -> crashed=${r.crashed} deployables=${r.deployableCount ?? '-'} links=${r.applicationLinkCount ?? '-'} time=${Date.now() - t0}ms`
    );
    workspaceResults.push(r);
  }

  let discoveredProjectCount = 0;
  let discoveredWorkspaceCount = 0;
  let cappedProjectCount = 0;

  if (!onlyLeads) {
    console.error('[corpus-sweep] === DISCOVERY ===');
    const { projects, workspaces, scanned } = await discover(root);
    discoveredProjectCount = projects.length;
    discoveredWorkspaceCount = workspaces.length;
    console.error(`[corpus-sweep] scanned ${scanned} dirs; found ${projects.length} project roots, ${workspaces.length} workspace roots`);

    // De-dup: skip any project/workspace already covered by a lead target.
    const leadPaths = new Set([...LEAD_PROJECTS, ...LEAD_WORKSPACES].map((p) => path.resolve(p)));
    const remainingProjects = projects.filter((p) => !leadPaths.has(path.resolve(p.dirPath)) && !isExcluded(p.dirPath));
    const remainingWorkspaces = workspaces.filter((w) => !leadPaths.has(path.resolve(w.dirPath)) && !isExcluded(w.dirPath));

    let toRun = remainingProjects;
    if (toRun.length > maxProjects) {
      cappedProjectCount = toRun.length - maxProjects;
      console.error(`[corpus-sweep] CAPPING projects: ${toRun.length} found, running first ${maxProjects}, skipping ${cappedProjectCount}`);
      toRun = toRun.slice(0, maxProjects);
    }

    console.error(`[corpus-sweep] === PROJECTS (${toRun.length}) ===`);
    for (const proj of toRun) {
      console.error(`[corpus-sweep] project: ${proj.dirPath}`);
      const t0 = Date.now();
      try {
        const r = await analyzeProject(proj.dirPath, proj.name, true);
        console.error(
          `[corpus-sweep]   -> crashed=${r.crashed} nodes=${r.nodeCount ?? '-'} domain=${r.primaryDomain ?? '-'} deployables=${r.deployableCount ?? '-'} entryPoints=${r.entryPointCount ?? '-'} routes=${r.routeCount ?? '-'} time=${Date.now() - t0}ms${r.crashed ? ` ERROR=${r.error}` : ''}`
        );
        projectResults.push(r);
      } catch (err: any) {
        // analyzeProject already catches internally; this is a belt-and-suspenders
        // guard so a truly unexpected throw cannot abort the sweep.
        console.error(`[corpus-sweep]   -> UNCAUGHT: ${err?.message || err}`);
        projectResults.push({ name: proj.name, dirPath: proj.dirPath, hasManifest: true, crashed: true, error: String(err?.message || err) });
      }
    }

    console.error(`[corpus-sweep] === WORKSPACES (${remainingWorkspaces.length}) ===`);
    for (const ws of remainingWorkspaces) {
      const subs = await subDirsWithManifest(ws.dirPath);
      console.error(`[corpus-sweep] workspace: ${ws.dirPath} (${subs.length} sub-repos)`);
      if (subs.length === 0) continue;
      const t0 = Date.now();
      try {
        const r = await analyzeWorkspace(ws.dirPath, ws.name, subs);
        console.error(`[corpus-sweep]   -> crashed=${r.crashed} deployables=${r.deployableCount ?? '-'} time=${Date.now() - t0}ms${r.crashed ? ` ERROR=${r.error}` : ''}`);
        workspaceResults.push(r);
      } catch (err: any) {
        console.error(`[corpus-sweep]   -> UNCAUGHT: ${err?.message || err}`);
        workspaceResults.push({ name: ws.name, dirPath: ws.dirPath, subRepos: subs, crashed: true, error: String(err?.message || err), subRepoResults: [] });
      }
    }
  }

  const report: SweepReport = {
    root,
    projectResults,
    workspaceResults,
    discoveredProjectCount,
    discoveredWorkspaceCount,
    cappedProjectCount,
    onlyLeads,
  };

  const outPath = path.join(os.tmpdir(), 'klauro-corpus-sweep-report.json');
  await fs.writeJson(outPath, report, { spaces: 2 });
  console.error(`[corpus-sweep] DONE. report written to ${outPath}`);
  console.error(
    `[corpus-sweep] summary: ${projectResults.length} projects analyzed (${projectResults.filter((r) => r.crashed).length} crashed), ${workspaceResults.length} workspaces analyzed (${workspaceResults.filter((r) => r.crashed).length} crashed)`
  );
}

// ---------------------------------------------------------------------------
// Heap guard: re-exec with a raised --max-old-space-size before doing any work.
//
// A large repo's CAS response (e.g. Klauro's own 14GB proof-of-concept
// self-repo) can OOM V8 during response buffering/JSON.parse in
// product-analysis.ts — a fatal allocation failure, not a catchable JS
// exception, so no amount of try/catch in analyzeProject/analyzeWorkspace can
// save the process once it happens. Node's default heap ceiling (~4GB on this
// machine) is comfortably smaller than a single huge-repo CAS payload can
// require once chunks + concatenated buffer + utf8 string + parsed object are
// briefly co-resident. Raise the ceiling unconditionally by re-exec'ing this
// same script as a child with --max-old-space-size set, unless the caller
// already set one (respect an explicit override) or has opted out via
// CORPUS_SWEEP_NO_REEXEC (useful under a debugger/profiler).
const SWEEP_MIN_HEAP_MB = 8192;

function currentMaxOldSpaceMb(): number | null {
  const opts = process.env.NODE_OPTIONS || '';
  const fromEnv = opts.match(/--max-old-space-size=(\d+)/);
  if (fromEnv) return Number(fromEnv[1]);
  const fromArgv = process.execArgv.find((a) => a.startsWith('--max-old-space-size='));
  if (fromArgv) return Number(fromArgv.split('=')[1]);
  return null;
}

function reexecWithLargerHeap(): void {
  const { spawnSync } = require('child_process') as typeof import('child_process');
  const nodeArgs = [`--max-old-space-size=${SWEEP_MIN_HEAP_MB}`, ...process.execArgv, __filename, ...process.argv.slice(2)];
  console.error(`[corpus-sweep] re-exec with --max-old-space-size=${SWEEP_MIN_HEAP_MB} (was ${currentMaxOldSpaceMb() ?? 'default ~4096'})`);
  const result = spawnSync(process.execPath, nodeArgs, { stdio: 'inherit', env: process.env });
  process.exit(result.status ?? 1);
}

if (require.main === module) {
  const current = currentMaxOldSpaceMb();
  if (process.env.CORPUS_SWEEP_NO_REEXEC !== '1' && (current === null || current < SWEEP_MIN_HEAP_MB)) {
    reexecWithLargerHeap();
  } else {
    main().catch((err) => {
      console.error('[corpus-sweep] FATAL', err);
      process.exit(1);
    });
  }
}
