/**
 * Workspace (WAS) agent benchmark.
 *
 * The single-repo agent benchmarks (agent-quality-benchmark) prove Klauro's
 * value on one codebase. Klauro's advantage is LARGEST on multi-repo workspace
 * tasks: without it, an agent answering a cross-repo question ("which service
 * owns this capability?", "how does the UI reach the worker?", "where does this
 * entity flow across services?") does not know which of the N repos are involved,
 * so it must search across ALL of them. With Klauro's workspace agent context it
 * gets the exact involved surfaces, the source-backed cross-repo connections, and
 * the entity paths directly.
 *
 * This harness builds the WAS for each workspace, generates cross-repo tasks from
 * its facts, and measures the with-Klauro vs without-Klauro arms on the same
 * quality / token / file / time axes as the single-repo benchmark, plus the
 * workspace-specific "how many repos did each arm have to touch?" axis.
 */
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { getAnalysis } from './analyzer';
import { analyzeForBench } from './gauntlet/product-analysis';
import { listAnalyses } from './storage';
import { resolveWorkspaceInputPaths } from './workspace-inputs';
import {
  buildCrossCodebaseSystemGraph,
  enrichWorkspaceAnalysisNarrative,
  buildWorkspaceAgentContext,
  type CrossCodebaseSystemGraph,
} from './cross-codebase-analysis';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { isDirectCliInvocation } from './cli-invocation';

const TOKENS_PER_FILE_READ = 1500; // avg tokens to read a candidate source file
const TOKENS_PER_GREP_HIT = 45;    // avg tokens to list one grep candidate
const MS_PER_FILE_READ = 1400;     // wall-clock to read+reason over one file
const MS_PER_GREP_PASS = 900;      // wall-clock for one repo-wide search pass

type WorkspaceTaskType = 'locate-capability' | 'trace-entity' | 'trace-connection' | 'cross-repo-change';

interface WorkspaceTask {
  id: string;
  label: string;
  type: WorkspaceTaskType;
  target: string;
  instructions: string;
  /** Repos a correct answer must touch (the ground-truth involvement). */
  involved_projects: string[];
}

interface WorkspaceTrial {
  workspace: string;
  task_id: string;
  task_label: string;
  task_type: WorkspaceTaskType;
  target: string;
  involved_project_count: number;
  with_klauro: {
    resolved: boolean;
    surfaces_named: number;
    files_to_read: number;
    context_tokens: number;
    signal_quality: string;
    repos_touched: number;
  };
  without_klauro: {
    repos_searched: number;
    search_files: number;
    search_tokens: number;
    candidate_files_read: number;
    projected_success_probability: number;
    estimated_solution_ms: number;
  };
  deltas: {
    token_reduction_percentage: number;
    file_reduction_percentage: number;
    time_reduction_percentage: number;
    repos_touched_reduction: number;
    success_probability_delta: number;
  };
  quality_score: number;
  status: 'pass' | 'warn' | 'fail';
}

interface RepoInput { path: string; name: string; cas: CASOutput; sourceFiles: number }

function sourceFileCount(cas: any): number {
  return (cas.nodes || []).filter((node: any) => node.type === 'file').length || (cas.system?.file_count || 30);
}

function projectName(graph: CrossCodebaseSystemGraph, id: string): string {
  return graph.codebases.find(codebase => codebase.id === id)?.name || id;
}

/** Generate cross-repo tasks from WAS facts (capabilities/entities/links that span repos). */
function generateWorkspaceTasks(graph: CrossCodebaseSystemGraph): WorkspaceTask[] {
  const tasks: WorkspaceTask[] = [];

  for (const capability of (graph.workspace_capabilities || []).filter(cap => (cap.project_ids || []).length >= 2).slice(0, 6)) {
    const projects = capability.project_ids.map(id => projectName(graph, id));
    tasks.push({
      id: `cap-${capability.id}`,
      label: `Locate capability: ${capability.name}`,
      type: 'locate-capability',
      target: capability.name,
      instructions: `Find every service/repo that implements the "${capability.name}" capability and how they collaborate.`,
      involved_projects: projects,
    });
  }

  for (const entity of (graph.workspace_entities || []).filter(ent => (ent.project_ids || []).length >= 2).slice(0, 6)) {
    const projects = entity.project_ids.map(id => projectName(graph, id));
    tasks.push({
      id: `ent-${entity.id}`,
      label: `Trace entity across services: ${entity.name}`,
      type: 'trace-entity',
      target: entity.name,
      instructions: `Trace where the "${entity.name}" entity is created, read, and written across the workspace, and which services own it.`,
      involved_projects: projects,
    });
  }

  // Cross-repo connections. Label by REPO (codebase) names — application names
  // collide across repos (many "mcp-server"/"client" deployables) — and dedupe by
  // the unordered repo pair so the same edge isn't scored once per surface.
  const seenRepoPairs = new Set<string>();
  const crossLinks = (graph.application_links || []).filter(link => link.source_codebase_id !== link.target_codebase_id);
  for (const link of crossLinks) {
    const sourceRepo = projectName(graph, link.source_codebase_id);
    const targetRepo = projectName(graph, link.target_codebase_id);
    if (sourceRepo === targetRepo) continue;
    const pairKey = [sourceRepo, targetRepo].sort().join('::');
    if (seenRepoPairs.has(pairKey)) continue;
    seenRepoPairs.add(pairKey);
    tasks.push({
      id: `link-${link.source_codebase_id}-${link.target_codebase_id}`,
      label: `Trace connection: ${sourceRepo} -> ${targetRepo}`,
      type: 'trace-connection',
      target: `${sourceRepo} ${targetRepo}`,
      instructions: `Explain how ${sourceRepo} reaches ${targetRepo} (protocol, surface, and where the call/handler lives).`,
      involved_projects: [sourceRepo, targetRepo],
    });
    if (seenRepoPairs.size >= 6) break;
  }

  return tasks;
}

function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }

function runWorkspaceTrial(graph: CrossCodebaseSystemGraph, task: WorkspaceTask, repos: RepoInput[]): WorkspaceTrial {
  // --- WITH KLAURO: the workspace agent context targets the task directly. ---
  const context = buildWorkspaceAgentContext(graph, { task_type: 'cross-repo', target: task.target, instructions: task.instructions });
  const namedProjects = new Set<string>([
    ...context.selected_surfaces.map(surface => surface.project),
    ...(context.linked_supporting_surfaces || []).map(surface => surface.project),
  ]);
  const involvedCovered = task.involved_projects.filter(project => namedProjects.has(project)).length;
  const resolved = involvedCovered >= Math.min(2, task.involved_projects.length);
  const withFiles = context.selected_surfaces.length + (context.linked_supporting_surfaces?.length || 0) + context.source_backed_connections.length;
  const withTokens = context.context_budget.estimated_context_tokens;
  const withRepos = namedProjects.size;

  // --- WITHOUT KLAURO: the agent does not know which repos are involved, so it
  // must grep across ALL workspace repos, then read candidate matches. ---
  const targetTerms = task.target.toLowerCase().split(/\s+/).filter(term => term.length >= 4);
  const candidatePerRepo = repos.map(repo => {
    // Fraction of a repo's files that would match a grep for the target terms.
    const base = Math.max(1, Math.round(repo.sourceFiles * 0.04));
    return Math.min(repo.sourceFiles, base + (targetTerms.length ? targetTerms.length : 1));
  });
  const totalCandidates = candidatePerRepo.reduce((sum, value) => sum + value, 0);
  const filesActuallyRead = Math.min(totalCandidates, 12); // an agent reads only the top candidates before giving up/answering
  const searchTokens = totalCandidates * TOKENS_PER_GREP_HIT + filesActuallyRead * TOKENS_PER_FILE_READ;
  const searchMs = repos.length * MS_PER_GREP_PASS + filesActuallyRead * MS_PER_FILE_READ;
  // Without the workspace map, the chance of correctly identifying ALL involved
  // services degrades with repo count and candidate sprawl.
  let withoutSuccess = 0.82;
  withoutSuccess -= 0.07 * Math.max(0, repos.length - 2);
  withoutSuccess -= 0.10 * Math.max(0, task.involved_projects.length - 2);
  if (totalCandidates > 40) withoutSuccess -= 0.12;
  if (totalCandidates > 120) withoutSuccess -= 0.15;
  withoutSuccess = clamp01(withoutSuccess);

  const withMs = context.context_budget.signal_quality === 'low' ? 4200 : 2600;

  const tokenReduction = Math.max(0, Math.round((1 - withTokens / Math.max(searchTokens, 1)) * 100));
  const fileReduction = Math.max(0, Math.round((1 - withFiles / Math.max(filesActuallyRead, 1)) * 100));
  const timeReduction = Math.max(0, Math.round((1 - withMs / Math.max(searchMs, 1)) * 100));

  const withSuccess = resolved ? 0.97 : 0.7;
  const qualityScore = Math.round(average([
    resolved ? 100 : 60,
    context.context_budget.signal_quality === 'high' ? 100 : context.context_budget.signal_quality === 'medium' ? 80 : 55,
    Math.min(100, 60 + tokenReduction / 2),
    involvedCovered >= task.involved_projects.length ? 100 : 80,
  ]));

  return {
    workspace: graph.name,
    task_id: task.id,
    task_label: task.label,
    task_type: task.type,
    target: task.target,
    involved_project_count: task.involved_projects.length,
    with_klauro: {
      resolved,
      surfaces_named: context.selected_surfaces.length,
      files_to_read: withFiles,
      context_tokens: withTokens,
      signal_quality: context.context_budget.signal_quality,
      repos_touched: withRepos,
    },
    without_klauro: {
      repos_searched: repos.length,
      search_files: totalCandidates,
      search_tokens: searchTokens,
      candidate_files_read: filesActuallyRead,
      projected_success_probability: Number(withoutSuccess.toFixed(2)),
      estimated_solution_ms: searchMs,
    },
    deltas: {
      token_reduction_percentage: tokenReduction,
      file_reduction_percentage: fileReduction,
      time_reduction_percentage: timeReduction,
      repos_touched_reduction: repos.length - withRepos,
      success_probability_delta: Number((withSuccess - withoutSuccess).toFixed(2)),
    },
    quality_score: qualityScore,
    status: qualityScore >= 85 ? 'pass' : qualityScore >= 70 ? 'warn' : 'fail',
  };
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function analyzeWorkspace(name: string, repoPaths: string[], fresh: boolean, withAi: boolean): Promise<{ graph: CrossCodebaseSystemGraph; repos: RepoInput[] }> {
  const repos: RepoInput[] = [];
  for (const repoPath of repoPaths) {
    if (!(await fs.pathExists(repoPath))) continue;
    try {
      const cas = fresh ? await analyzeForBench(repoPath) : await getAnalysis(repoPath);
      repos.push({ path: repoPath, name: cas.system?.name || path.basename(repoPath), cas, sourceFiles: sourceFileCount(cas) });
    } catch {
      // skip repos without a usable analysis
    }
  }
  let graph = buildCrossCodebaseSystemGraph(`${name.toLowerCase()}-system`, repos.map(repo => ({ path: repo.path, name: repo.name, cas: repo.cas })));
  // The deterministic graph already carries workspace_capabilities / _entities /
  // application_links, which is everything this benchmark scores. The AI narrative
  // enrichment only polishes prose, so it is opt-in (--with-ai) to keep the
  // default run fast and deterministic, mirroring the gauntlet's no-AI fast path.
  if (withAi) graph = await enrichWorkspaceAnalysisNarrative(graph);
  return { graph, repos };
}

interface FamilyConfig { name: string; repos: string[] }

/** Mirror the gauntlet's filter: drop generated/legacy/benchmark analysis paths. */
function isGeneratedOrLegacyFamilyPath(candidate: string, root: string): boolean {
  return path.relative(root, candidate).split(path.sep).some(part =>
    part === 'node_modules' ||
    part === 'legacy' ||
    part.startsWith('.unravl') ||
    part.startsWith('.klauro') ||
    part.includes('live-trial') ||
    part.includes('benchmark'));
}

/**
 * Discover workspace families from the set of cached CAS analyses, grouping
 * analyzed repos under each family root. This reproduces the cross-codebase
 * gauntlet's member selection (legacy/generated-path filter + workspace input
 * policy) so the repo counts are the real member set, not an inflated one.
 */
async function discoverFamilies(devRoot: string): Promise<FamilyConfig[]> {
  const analyses = await listAnalyses().catch(() => []);
  const analyzedPaths = analyses.map(analysis => path.resolve(analysis.path));
  const roots: Array<{ name: string; root: string }> = [
    { name: 'Soon', root: path.join(devRoot, 'soon') },
    { name: 'Zerac', root: path.join(devRoot, 'zerac') },
    { name: 'Klauro', root: path.join(devRoot, 'unravl', 'proof-of-concept') },
  ];
  const families: FamilyConfig[] = [];
  for (const { name, root } of roots) {
    const resolvedRoot = path.resolve(root);
    if (analyzedPaths.includes(resolvedRoot)) { families.push({ name, repos: [resolvedRoot] }); continue; }
    const candidates = analyzedPaths
      .filter(candidate => candidate.startsWith(`${resolvedRoot}${path.sep}`))
      .filter(candidate => !isGeneratedOrLegacyFamilyPath(candidate, resolvedRoot));
    const resolved = await resolveWorkspaceInputPaths({ workspaceRoot: resolvedRoot, paths: candidates });
    const repos = resolved.includedPaths.sort();
    if (repos.length >= 2) families.push({ name, repos });
  }
  return families;
}

export async function runWorkspaceAgentBenchmark(options: { devRoot?: string; fresh?: boolean; withAi?: boolean; families?: FamilyConfig[] }) {
  const devRoot = options.devRoot || path.join(os.homedir(), 'dev');
  const families = options.families || (await discoverFamilies(devRoot));
  const workspaces: Array<{ name: string; repo_count: number; trials: WorkspaceTrial[] }> = [];

  for (const family of families) {
    const { graph, repos } = await analyzeWorkspace(family.name, family.repos, Boolean(options.fresh), Boolean(options.withAi));
    if (repos.length < 2) continue;
    const tasks = generateWorkspaceTasks(graph);
    const trials = tasks.map(task => runWorkspaceTrial(graph, task, repos));
    workspaces.push({ name: family.name, repo_count: repos.length, trials });
  }

  const allTrials = workspaces.flatMap(workspace => workspace.trials);
  const summary = {
    workspace_count: workspaces.length,
    cross_repo_task_count: allTrials.length,
    mean_quality_score: Math.round(average(allTrials.map(trial => trial.quality_score))),
    mean_token_reduction_percentage: Math.round(average(allTrials.map(trial => trial.deltas.token_reduction_percentage))),
    mean_file_reduction_percentage: Math.round(average(allTrials.map(trial => trial.deltas.file_reduction_percentage))),
    mean_time_reduction_percentage: Math.round(average(allTrials.map(trial => trial.deltas.time_reduction_percentage))),
    mean_repos_touched_with_klauro: Number(average(allTrials.map(trial => trial.with_klauro.repos_touched)).toFixed(1)),
    mean_repos_searched_without_klauro: Number(average(allTrials.map(trial => trial.without_klauro.repos_searched)).toFixed(1)),
    mean_success_probability_delta: Number(average(allTrials.map(trial => trial.deltas.success_probability_delta)).toFixed(2)),
  };

  return {
    generated_at: new Date().toISOString(),
    benchmark_type: 'workspace-agent-quality-ab',
    methodology: 'projected',
    methodology_note:
      'With-Klauro arm uses the real WorkspaceAgentContext (selected surfaces, ' +
      'source-backed connections, context token budget). Without-Klauro arm is a ' +
      'MODEL-BASED PROJECTION of grep-across-all-repos search cost (documented ' +
      'per-file/grep token and time constants), not a live agent run. It measures ' +
      'how much context a workspace map removes, not measured end-to-end latency.',
    status: allTrials.every(trial => trial.status !== 'fail') ? 'pass' : 'warn',
    summary,
    workspaces,
  };
}

function formatMarkdown(report: Awaited<ReturnType<typeof runWorkspaceAgentBenchmark>>): string {
  const s = report.summary;
  const lines = [
    '# Workspace Agent Benchmark (Klauro WAS vs no-Klauro multi-repo search)',
    '',
    `Status: ${report.status.toUpperCase()}  |  Generated: ${report.generated_at}  |  Methodology: ${report.methodology}`,
    '',
    `> ${report.methodology_note}`,
    '',
    `- Workspaces: ${s.workspace_count}  |  Cross-repo tasks: ${s.cross_repo_task_count}`,
    `- Mean quality (with Klauro): ${s.mean_quality_score}/100`,
    `- Mean token reduction vs multi-repo search: ${s.mean_token_reduction_percentage}%`,
    `- Mean file reduction: ${s.mean_file_reduction_percentage}%  |  time reduction: ${s.mean_time_reduction_percentage}%`,
    `- Repos touched: ${s.mean_repos_touched_with_klauro} (with Klauro) vs ${s.mean_repos_searched_without_klauro} searched (without)`,
    `- Mean success-probability advantage: +${s.mean_success_probability_delta}`,
    '',
  ];
  for (const workspace of report.workspaces) {
    lines.push(`## ${workspace.name} (${workspace.repo_count} repos)`);
    for (const trial of workspace.trials) {
      lines.push(`- [${trial.status}] ${trial.task_label} — token −${trial.deltas.token_reduction_percentage}%, time −${trial.deltas.time_reduction_percentage}%, repos ${trial.with_klauro.repos_touched} vs ${trial.without_klauro.repos_searched}, +${trial.deltas.success_probability_delta} success (with ${trial.with_klauro.context_tokens}t / without ${trial.without_klauro.search_tokens}t)`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  let devRoot: string | undefined;
  let fresh = false;
  let withAi = false;
  let output: string | undefined;
  let markdown: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dev-root') devRoot = path.resolve(argv[++i]);
    else if (arg === '--fresh') fresh = true;
    else if (arg === '--with-ai') withAi = true;
    else if (arg === '--output') output = argv[++i];
    else if (arg === '--markdown') markdown = argv[++i];
    else if (arg === '--json') json = true;
  }
  const report = await runWorkspaceAgentBenchmark({ devRoot, fresh, withAi });
  if (output) { await fs.ensureDir(path.dirname(path.resolve(output))); await fs.writeJson(path.resolve(output), report, { spaces: 2 }); }
  if (markdown) { await fs.ensureDir(path.dirname(path.resolve(markdown))); await fs.writeFile(path.resolve(markdown), formatMarkdown(report)); }
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${formatMarkdown(report)}\n`);
}

if (isDirectCliInvocation('workspace-agent-benchmark')) {
  main().catch(error => { console.error(error); process.exit(1); });
}
