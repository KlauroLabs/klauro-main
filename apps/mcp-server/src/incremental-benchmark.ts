import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { glob } from 'glob';
import pLimit from 'p-limit';
import { type IncrementalAnalysisResult } from './analyzer';
import { analyzeForBench } from './gauntlet/product-analysis';
import { getAgentContext } from './agent-adoption';
import { discoverTargets, type RepoTarget } from './gauntlet';
import { getFileCacheSize, loadIncrementalState, saveAgenticBenchmarkReport } from './storage';
import { isDirectCliInvocation } from './cli-invocation';
import { analyzeWithInstalledKlauro } from './installed-klauro';

type GateStatus = 'pass' | 'warn' | 'fail';

interface IncrementalTargetInput {
  name?: string;
  path: string;
}

interface IncrementalBenchmarkOptions {
  repos: IncrementalTargetInput[];
  includeRealRepos?: boolean;
  devRoot?: string;
  maxTargets?: number;
  workRoot?: string;
  keepWorkspaces?: boolean;
  verifyFull?: boolean;
  useGitBaseline?: boolean;
  quiet?: boolean;
  concurrency?: number;
  analysisPath?: 'in-process-harness' | 'klauro-product';
  // Hosted server for the klauro-product in-flight path. When set, the installed
  // CLI runs in remote mode against this URL (production by default); when unset
  // it runs offline local. Mirrors the cold/warm path in machine-gauntlet.
  analyzerServerUrl?: string;
  progress?: (event: { target: string; path: string; stage: 'start' | 'complete' | 'failed'; duration_ms?: number; error?: string }) => void;
}

interface IncrementalTargetReport {
  name: string;
  original_path: string;
  workspace: string;
  edited_file?: string;
  edit: {
    kind: 'syntactic-probe' | 'whitespace-fallback';
    detail: string;
  };
  status: GateStatus;
  score: number;
  gates: Array<{ id: string; status: GateStatus; score: number; detail: string }>;
  timings: {
    total_wall_ms: number;
    initial_full_ms: number;
    no_change_incremental_ms: number;
    edit_incremental_ms: number;
    edit_loop_wall_ms: number;
    verify_full_after_edit_ms?: number;
    copy_repo_ms?: number;
    git_baseline_ms?: number;
    edit_selection_ms?: number;
    edit_apply_ms?: number;
    context_generation_ms?: number;
    token_proof_ms?: number;
    state_load_ms?: number;
    cache_size_ms?: number;
  };
  speedups: {
    no_change_vs_full: number;
    edit_incremental_vs_full: number;
    edit_incremental_vs_verify_full?: number;
  };
  change_summary: {
    files_changed: number;
    files_added: number;
    files_modified: number;
    files_deleted: number;
    nodes_added: number;
    nodes_modified: number;
    nodes_deleted: number;
    risk_level: string;
    was_full_rebuild: boolean;
    full_rebuild_reason?: string;
  };
  output_summary: {
    nodes: number;
    edges: number;
    entry_points: number;
    exit_points: number;
    analysis_errors: number;
    tracked_files: number;
    file_cache_entries: number;
    file_cache_bytes: number;
  };
  agent_value_after_edit: {
    context_generation_ms: number;
    file_read_plan_count: number;
    next_mcp_calls: number;
    estimated_context_tokens: number;
    estimated_source_tokens: number;
    estimated_total_context_tokens: number;
    estimated_search_baseline_tokens: number;
    estimated_search_token_reduction_percentage: number;
    estimated_cold_scan_tokens: number;
    estimated_cold_scan_token_reduction_percentage: number;
    selected_node?: unknown;
    agent_context_ready?: boolean;
  };
  full_verify_parity?: {
    node_delta: number;
    edge_delta: number;
    entry_point_delta: number;
    exit_point_delta: number;
    absolute_delta: number;
    count_similarity: number;
  };
}

function parseArgs(argv: string[]) {
  const repos: IncrementalTargetInput[] = [];
  let includeRealRepos = false;
  let devRoot = path.join(process.env.HOME || '', 'dev');
  let maxTargets = 6;
  let workRoot = defaultIncrementalBenchmarkWorkRoot();
  let outputPath = path.join(process.cwd(), '.klauro-incremental-benchmark', 'latest-report.json');
  let markdownPath = path.join(process.cwd(), '.klauro-incremental-benchmark', 'latest-report.md');
  let keepWorkspaces = false;
  let verifyFull = true;
  let useGitBaseline = false;
  let concurrency = 1;
  let analysisPath: IncrementalBenchmarkOptions['analysisPath'] = 'in-process-harness';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') {
      const value = argv[++i];
      if (!value) throw new Error('--repo requires a path or name=path value');
      const [namePart, repoPathPart] = value.includes('=') ? value.split('=') : [undefined, value];
      const repoPath = path.resolve(repoPathPart);
      repos.push({ name: namePart || path.basename(repoPath), path: repoPath });
    } else if (arg === '--real-repos') {
      includeRealRepos = true;
    } else if (arg === '--dev-root') {
      devRoot = path.resolve(argv[++i]);
    } else if (arg === '--max-targets') {
      maxTargets = Number(argv[++i]);
    } else if (arg === '--work-root') {
      workRoot = path.resolve(argv[++i]);
    } else if (arg === '--output') {
      outputPath = path.resolve(argv[++i]);
    } else if (arg === '--markdown') {
      markdownPath = path.resolve(argv[++i]);
    } else if (arg === '--discard-workspaces') {
      keepWorkspaces = false;
    } else if (arg === '--keep-workspaces') {
      keepWorkspaces = true;
    } else if (arg === '--verify-full') {
      verifyFull = true;
    } else if (arg === '--no-verify-full') {
      verifyFull = false;
    } else if (arg === '--git-baseline') {
      useGitBaseline = true;
    } else if (arg === '--concurrency') {
      concurrency = Number(argv[++i]);
    } else if (arg === '--analysis-path') {
      analysisPath = parseAnalysisPath(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { repos, includeRealRepos, devRoot, maxTargets, workRoot, outputPath, markdownPath, keepWorkspaces, verifyFull, useGitBaseline, concurrency, analysisPath };
}

function parseAnalysisPath(value: string): IncrementalBenchmarkOptions['analysisPath'] {
  if (value === 'klauro-product') return 'klauro-product';
  if (value === 'in-process-harness') return 'in-process-harness';
  throw new Error(`Invalid incremental benchmark analysis path "${value}". Expected klauro-product or in-process-harness.`);
}

function printHelp(): void {
  console.log([
    'Usage: npm run incremental-benchmark -- [options]',
    '',
    'Options:',
    '  --repo name=/path/to/repo     Benchmark a specific repo. May be repeated.',
    '  --real-repos                 Include discovered repos under --dev-root.',
    '  --dev-root /path             Root used for real repo discovery.',
    '  --max-targets n              Limit total targets.',
    '  --work-root /path            Directory for copied repo workspaces and isolated storage.',
    '  --verify-full                Run a fresh full analysis after the edit and compare parity.',
    '  --no-verify-full             Skip the fresh full analysis parity check.',
    '  --git-baseline               Initialize and commit a git baseline in copied repos. Off by default to measure agent-facing incremental value without benchmark-only git overhead.',
    '  --concurrency n             Number of repos to benchmark concurrently. Default 1. Values above 1 are capped because storage isolation is process-scoped.',
    '  --analysis-path path         Analysis path: klauro-product or in-process-harness. Default in-process-harness.',
    '  --discard-workspaces         Remove copied repos after writing the report. This is the default.',
    '  --keep-workspaces            Keep copied repos for debugging.',
    '  --output /path/report.json   Write JSON report.',
    '  --markdown /path/report.md   Write Markdown report.',
  ].join('\n'));
}

export async function runIncrementalValueBenchmark(options: IncrementalBenchmarkOptions) {
  const selectedTargets = await selectTargets(options);
  if (selectedTargets.length === 0) throw new Error('No incremental benchmark targets configured');

  const limit = pLimit(1);
  const runTargets = async () => Promise.all(selectedTargets.map(target => limit(async () => {
    if (!options.quiet) console.log(`Incremental benchmarking ${target.name}: ${target.path}`);
    const startedAt = Date.now();
    options.progress?.({ target: target.name || path.basename(target.path), path: target.path, stage: 'start' });
    try {
      const result = await benchmarkTarget(target, options);
      options.progress?.({ target: result.name, path: target.path, stage: 'complete', duration_ms: Date.now() - startedAt });
      return result;
    } catch (error) {
      options.progress?.({
        target: target.name || path.basename(target.path),
        path: target.path,
        stage: 'failed',
        duration_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      return failedIncrementalTargetReport(target, error, Date.now() - startedAt);
    }
  })));
  const reports = options.quiet ? await withQuietLogs(true, runTargets) : await runTargets();

  const generatedAt = new Date().toISOString();
  const report = {
    generated_at: generatedAt,
    generatedAt,
    benchmark_type: 'incremental-analysis-agent-value',
    status: aggregateStatus(reports.map(target => target.status)),
    score: Math.round(average(reports.map(target => target.score))),
    summary: {
      target_count: reports.length,
      targets_passed: reports.filter(target => target.status === 'pass').length,
      targets_warned: reports.filter(target => target.status === 'warn').length,
      targets_failed: reports.filter(target => target.status === 'fail').length,
      target_pass_rate: Number((average(reports.map(target => target.status === 'pass' ? 100 : 0)) / 100).toFixed(2)),
      incremental_success_rate: Number((average(reports.map(target => !target.change_summary.was_full_rebuild ? 100 : 0)) / 100).toFixed(2)),
      average_initial_full_ms: Math.round(average(reports.map(target => target.timings.initial_full_ms))),
      average_no_change_incremental_ms: Math.round(average(reports.map(target => target.timings.no_change_incremental_ms))),
      average_edit_incremental_ms: Math.round(average(reports.map(target => target.timings.edit_incremental_ms))),
      average_total_wall_ms: Math.round(average(reports.map(target => target.timings.total_wall_ms))),
      average_edit_loop_wall_ms: Math.round(average(reports.map(target => target.timings.edit_loop_wall_ms))),
      average_non_analysis_overhead_ms: Math.round(average(reports.map(target => nonAnalysisOverheadMs(target.timings)))),
      average_no_change_speedup_vs_full: Number(average(reports.map(target => target.speedups.no_change_vs_full)).toFixed(2)),
      average_edit_speedup_vs_full: Number(average(reports.map(target => target.speedups.edit_incremental_vs_full)).toFixed(2)),
      average_context_generation_ms_after_edit: Math.round(average(reports.map(target => target.agent_value_after_edit.context_generation_ms))),
      average_file_read_plan_after_edit: Math.round(average(reports.map(target => target.agent_value_after_edit.file_read_plan_count))),
      average_context_tokens_after_edit: Math.round(average(reports.map(target => target.agent_value_after_edit.estimated_context_tokens))),
      average_total_context_tokens_after_edit: Math.round(average(reports.map(target => target.agent_value_after_edit.estimated_total_context_tokens))),
      average_search_baseline_tokens_after_edit: Math.round(average(reports.map(target => target.agent_value_after_edit.estimated_search_baseline_tokens))),
      average_search_token_reduction_after_edit: Math.round(average(reports.map(target => target.agent_value_after_edit.estimated_search_token_reduction_percentage))),
      average_cold_scan_token_reduction_after_edit: Math.round(average(reports.map(target => target.agent_value_after_edit.estimated_cold_scan_token_reduction_percentage))),
      average_full_verify_count_similarity: average(
        reports
          .map(target => target.full_verify_parity?.count_similarity)
          .filter((value): value is number => typeof value === 'number')
      ),
    },
    targets: reports,
  };

  if (options.keepWorkspaces === false) {
    for (const target of reports) await fs.remove(target.workspace).catch(() => undefined);
  }

  return report;
}

function failedIncrementalTargetReport(
  target: IncrementalTargetInput,
  error: unknown,
  durationMs: number
): IncrementalTargetReport {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    name: target.name || path.basename(target.path),
    original_path: path.resolve(target.path),
    workspace: '',
    edit: {
      kind: 'whitespace-fallback',
      detail: 'No edit applied because incremental proof failed before edit selection.',
    },
    status: 'fail',
    score: 0,
    gates: [
      {
        id: 'incremental-target-completed',
        status: 'fail',
        score: 0,
        detail,
      },
    ],
    timings: {
      total_wall_ms: Math.max(1, durationMs),
      initial_full_ms: Math.max(1, durationMs),
      no_change_incremental_ms: 0,
      edit_incremental_ms: 0,
      edit_loop_wall_ms: 0,
    },
    speedups: {
      no_change_vs_full: 0,
      edit_incremental_vs_full: 0,
    },
    change_summary: {
      files_changed: 0,
      files_added: 0,
      files_modified: 0,
      files_deleted: 0,
      nodes_added: 0,
      nodes_modified: 0,
      nodes_deleted: 0,
      risk_level: 'unknown',
      was_full_rebuild: true,
      full_rebuild_reason: detail,
    },
    output_summary: {
      nodes: 0,
      edges: 0,
      entry_points: 0,
      exit_points: 0,
      analysis_errors: 1,
      tracked_files: 0,
      file_cache_entries: 0,
      file_cache_bytes: 0,
    },
    agent_value_after_edit: {
      context_generation_ms: 0,
      file_read_plan_count: 0,
      next_mcp_calls: 0,
      estimated_context_tokens: 0,
      estimated_source_tokens: 0,
      estimated_total_context_tokens: 0,
      estimated_search_baseline_tokens: 0,
      estimated_search_token_reduction_percentage: 0,
      estimated_cold_scan_tokens: 0,
      estimated_cold_scan_token_reduction_percentage: 0,
      agent_context_ready: false,
    },
  };
}

async function selectTargets(options: IncrementalBenchmarkOptions): Promise<IncrementalTargetInput[]> {
  const realRepos: RepoTarget[] = options.includeRealRepos
    || options.repos.length === 0
    ? await discoverTargets(options.devRoot || path.join(process.env.HOME || '', 'dev'))
    : [];
  const discoveredTargets: IncrementalTargetInput[] = [];
  for (const repo of realRepos) {
    if (await isAggregateIncrementalBenchmarkTarget(repo.path)) continue;
    discoveredTargets.push({ name: repo.name, path: repo.path });
  }
  const selected = [
    ...discoveredTargets,
    ...options.repos.map(repo => ({ name: repo.name || path.basename(repo.path), path: path.resolve(repo.path) })),
  ];
  const seen = new Set<string>();
  return selected.filter(target => {
    const resolved = path.resolve(target.path);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  }).slice(0, options.maxTargets || selected.length);
}

async function isAggregateIncrementalBenchmarkTarget(repoPath: string): Promise<boolean> {
  const nestedRepos = await glob('**/.git', {
    cwd: repoPath,
    dot: true,
    ignore: [
      '.git/**',
      '**/node_modules/**',
      '**/.klauro*/**',
      '**/.venv/**',
      '**/venv/**',
      '**/env/**',
      '**/site-packages/**',
      '**/dist/**',
      '**/build/**',
      '**/target/**',
    ],
  });
  const hasNestedRepo = nestedRepos.some(match => path.dirname(match).replace(/\\/g, '/') !== '.');
  if (!hasNestedRepo) return false;

  const sourceFiles = await glob('**/*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,cs,php,dart}', {
    cwd: repoPath,
    nodir: true,
    ignore: [
      '**/node_modules/**',
      '**/.git/**',
      '**/.klauro*/**',
      '**/.venv/**',
      '**/venv/**',
      '**/env/**',
      '**/site-packages/**',
      '**/__pycache__/**',
      '**/dist/**',
      '**/build/**',
      '**/target/**',
      '**/coverage/**',
      '**/vendor/**',
      '**/vendors/**',
      '**/Generated/**',
      '**/generated/**',
    ],
  });
  return sourceFiles.length > 1000;
}

export function defaultIncrementalBenchmarkWorkRoot(): string {
  return path.join(os.tmpdir(), 'klauro-incremental-benchmark-workspaces');
}

async function benchmarkTarget(target: IncrementalTargetInput, options: IncrementalBenchmarkOptions): Promise<IncrementalTargetReport> {
  const targetStartedAt = Date.now();
  const trialRoot = path.join(path.resolve(options.workRoot || defaultIncrementalBenchmarkWorkRoot()), `${slugify(target.name || path.basename(target.path))}-${Date.now()}`);
  const workspace = path.join(trialRoot, 'repo');
  const storagePath = path.join(trialRoot, 'storage');
  await fs.ensureDir(trialRoot);
  try {
    const copyStartedAt = Date.now();
    await copyRepo(target.path, workspace);
    const copyRepoMs = Math.max(1, Date.now() - copyStartedAt);
    let gitBaselineMs = 0;
    if (options.useGitBaseline) {
      const gitBaselineStartedAt = Date.now();
      initializeBenchmarkGitBaseline(workspace);
      gitBaselineMs = Math.max(1, Date.now() - gitBaselineStartedAt);
    }

    const previousStorage = process.env.KLAURO_STORAGE_PATH;
    process.env.KLAURO_STORAGE_PATH = storagePath;
    try {
      const analysisPath = options.analysisPath || 'in-process-harness';
      const analysisFocus = 'agent-fast';
      const installedEnv = { KLAURO_STORAGE_PATH: storagePath };
      // klauro-product = the installed CLI, which always runs the hosted product
      // (production by default; serverUrl can target a self-hosted analyzer-server).
      const analyzeIncremental = () => analysisPath === 'klauro-product'
        ? analyzeWithInstalledKlauro(workspace, { env: installedEnv, analysisFocus, serverUrl: options.analyzerServerUrl, timeoutMs: 8 * 60 * 1000 })
        : analyzeForBench(workspace).then(output => ({ output, state: undefined, changeReport: undefined, wasFullRebuild: true, fullRebuildReason: 'bench-product' }) as any);
      const analyzeFull = () => analysisPath === 'klauro-product'
        ? analyzeWithInstalledKlauro(workspace, { env: installedEnv, analysisFocus, serverUrl: options.analyzerServerUrl, forceFull: true, timeoutMs: 8 * 60 * 1000 }).then(result => result.output)
        : analyzeForBench(workspace);

      const initial = await timed(() => analyzeIncremental());
      const noChange = await timed(() => analyzeIncremental());
      const editSelectionStartedAt = Date.now();
      const editFile = await chooseEditFile(initial.value.output, workspace);
      const editSelectionMs = Math.max(1, Date.now() - editSelectionStartedAt);
      if (!editFile) throw new Error(`No editable source file found in copied repo: ${workspace}`);
      const editLoopStartedAt = Date.now();
      const editApplyStartedAt = Date.now();
      const edit = await applySafeSourceEdit(path.join(workspace, editFile));
      const editApplyMs = Math.max(1, Date.now() - editApplyStartedAt);
      const edited = await timed(() => analyzeIncremental());

      const contextStartedAt = Date.now();
      const context = await getAgentContext(edited.value.output, workspace, {
        task_type: 'modify',
        target: targetFromEditedFile(edited.value.output, editFile),
        instructions: `Use the incremental change summary to inspect ${editFile} and preserve connected behavior.`,
      });
      const contextGenerationMs = Math.max(1, Date.now() - contextStartedAt);
      const tokenProofStartedAt = Date.now();
      const tokenProof = await estimatePostEditTokenProof(workspace, context, editFile);
      const tokenProofMs = Math.max(1, Date.now() - tokenProofStartedAt);
      const editLoopWallMs = Math.max(1, Date.now() - editLoopStartedAt);

      const verify = options.verifyFull ? await timed(() => analyzeFull()) : undefined;
      const stateLoadStartedAt = Date.now();
      const state = await loadIncrementalState(workspace);
      const stateLoadMs = Math.max(1, Date.now() - stateLoadStartedAt);
      const cacheSizeStartedAt = Date.now();
      const cacheSize = await getFileCacheSize(workspace);
      const cacheSizeMs = Math.max(1, Date.now() - cacheSizeStartedAt);
      const fullParity = verify ? compareCasCounts(edited.value.output, verify.value) : undefined;
      const gates = buildGates(initial, noChange, edited, context, edit, tokenProof, fullParity);
      const score = Math.round(average(gates.map(gate => gate.score)));
      const status = aggregateStatus(gates.map(gate => gate.status));

      return {
        name: target.name || path.basename(target.path),
        original_path: path.resolve(target.path),
        workspace,
        edited_file: editFile,
        edit,
        status,
        score,
        gates,
        timings: {
          total_wall_ms: Math.max(1, Date.now() - targetStartedAt),
          initial_full_ms: initial.durationMs,
          no_change_incremental_ms: noChange.durationMs,
          edit_incremental_ms: edited.durationMs,
          edit_loop_wall_ms: editLoopWallMs,
          verify_full_after_edit_ms: verify?.durationMs,
          copy_repo_ms: copyRepoMs,
          git_baseline_ms: gitBaselineMs,
          edit_selection_ms: editSelectionMs,
          edit_apply_ms: editApplyMs,
          context_generation_ms: contextGenerationMs,
          token_proof_ms: tokenProofMs,
          state_load_ms: stateLoadMs,
          cache_size_ms: cacheSizeMs,
        },
        speedups: {
          no_change_vs_full: ratio(initial.durationMs, noChange.durationMs),
          edit_incremental_vs_full: ratio(initial.durationMs, edited.durationMs),
          edit_incremental_vs_verify_full: verify ? ratio(verify.durationMs, edited.durationMs) : undefined,
        },
        change_summary: summarizeChange(edited.value),
        output_summary: {
          nodes: edited.value.output.nodes.length,
          edges: edited.value.output.edges.length,
          entry_points: edited.value.output.entry_points?.length || 0,
          exit_points: edited.value.output.exit_points?.length || 0,
          analysis_errors: edited.value.output.analysis_errors?.length || 0,
          tracked_files: Object.keys(state?.files || {}).length,
          file_cache_entries: cacheSize.files,
          file_cache_bytes: cacheSize.bytes,
        },
        agent_value_after_edit: {
          context_generation_ms: contextGenerationMs,
          file_read_plan_count: context.file_read_plan.length,
          next_mcp_calls: context.next_mcp_calls.length,
          estimated_context_tokens: estimateTokens(JSON.stringify(context).length),
          ...tokenProof,
          selected_node: context.selected_node,
          agent_context_ready: context.agent_context_ready,
        },
        full_verify_parity: fullParity,
      };
    } finally {
      if (previousStorage === undefined) {
        delete process.env.KLAURO_STORAGE_PATH;
      } else {
        process.env.KLAURO_STORAGE_PATH = previousStorage;
      }
    }
  } finally {
    if (options.keepWorkspaces === false) await fs.remove(trialRoot).catch(() => undefined);
  }
}

function nonAnalysisOverheadMs(timings: IncrementalTargetReport['timings']): number {
  const measured = timings.initial_full_ms
    + timings.no_change_incremental_ms
    + timings.edit_incremental_ms
    + (timings.verify_full_after_edit_ms || 0);
  return Math.max(0, Math.round((timings.total_wall_ms || measured) - measured));
}

function buildGates(
  initial: Timed<IncrementalAnalysisResult>,
  noChange: Timed<IncrementalAnalysisResult>,
  edited: Timed<IncrementalAnalysisResult>,
  context: Awaited<ReturnType<typeof getAgentContext>>,
  edit: IncrementalTargetReport['edit'],
  tokenProof: Awaited<ReturnType<typeof estimatePostEditTokenProof>>,
  parity?: IncrementalTargetReport['full_verify_parity']
) {
  const changedFiles = edited.value.changeReport.summary.filesAdded +
    edited.value.changeReport.summary.filesModified +
    edited.value.changeReport.summary.filesDeleted;
  const casDelta = summarizeCasDelta(edited.value);
  const editDetected = changedFiles > 0 || casDelta > 0;
  const editWasIncremental = !edited.value.wasFullRebuild;
  const editPerformanceAcceptable = editWasIncremental && (
    ratio(initial.durationMs, edited.durationMs) >= 1.2 ||
    edited.durationMs <= Math.max(noChange.durationMs * 8, 10000) ||
    (initial.durationMs < 1000 && edited.durationMs <= initial.durationMs + 750)
  );
  const gates = [
    gate('initial-analysis-complete', initial.value.output.nodes.length > 0, `${initial.value.output.nodes.length} nodes`),
    gate('initial-state-built', initial.value.wasFullRebuild, `wasFullRebuild=${initial.value.wasFullRebuild}`),
    gate('no-change-incremental', !noChange.value.wasFullRebuild, [
      `wasFullRebuild=${noChange.value.wasFullRebuild}`,
      noChange.value.fullRebuildReason ? `reason=${noChange.value.fullRebuildReason}` : '',
    ].filter(Boolean).join('; ')),
    gate('no-change-empty-summary', summarizeChangedFiles(noChange.value) === 0, `${summarizeChangedFiles(noChange.value)} files changed`),
    gate('syntactic-source-edit-applied', edit.kind === 'syntactic-probe', `${edit.kind}: ${edit.detail}`),
    gate('edit-detected', editDetected, `${changedFiles} files changed, ${casDelta} CAS nodes changed`),
    softGate('edit-produced-cas-delta', casDelta > 0 || changedFiles > 0, `${casDelta} CAS nodes changed, ${changedFiles} files changed`),
    gate('edit-stayed-incremental', !edited.value.wasFullRebuild, `wasFullRebuild=${edited.value.wasFullRebuild}`),
    softGate('edit-performance-acceptable', editPerformanceAcceptable, `${edited.durationMs}ms vs ${initial.durationMs}ms`),
    gate('agent-context-after-edit', context.file_read_plan.length > 0 && context.next_mcp_calls.length > 0, `${context.file_read_plan.length} files, ${context.next_mcp_calls.length} calls`),
    gate('agent-token-reduction-after-edit', tokenProof.estimated_search_token_reduction_percentage >= 25, `${tokenProof.estimated_search_token_reduction_percentage}% vs search, ${tokenProof.estimated_total_context_tokens}/${tokenProof.estimated_search_baseline_tokens} tokens`),
  ];
  if (parity) {
    gates.push(parityGate(parity));
  }
  return gates;
}

function summarizeChange(result: IncrementalAnalysisResult): IncrementalTargetReport['change_summary'] {
  const summary = result.changeReport.summary;
  return {
    files_changed: summary.filesAdded + summary.filesModified + summary.filesDeleted,
    files_added: summary.filesAdded,
    files_modified: summary.filesModified,
    files_deleted: summary.filesDeleted,
    nodes_added: summary.nodesAdded,
    nodes_modified: summary.nodesModified,
    nodes_deleted: summary.nodesDeleted,
    risk_level: result.changeReport.impact.riskLevel,
    was_full_rebuild: result.wasFullRebuild,
    full_rebuild_reason: result.fullRebuildReason,
  };
}

function summarizeChangedFiles(result: IncrementalAnalysisResult): number {
  return result.changeReport.summary.filesAdded +
    result.changeReport.summary.filesModified +
    result.changeReport.summary.filesDeleted;
}

async function chooseEditFile(cas: IncrementalAnalysisResult['output'], workspace: string): Promise<string | null> {
  const entryFiles = (cas.entry_points || [])
    .map(entry => cas.nodes.find(node => node.id === entry.source_node)?.source?.file)
    .filter((file): file is string => Boolean(file))
    .map(file => path.isAbsolute(file) ? path.relative(workspace, file) : file);
  const sourceFiles = await glob(['**/*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,cs,php,dart,tf,tfvars}'], {
    cwd: workspace,
    ignore: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.git/**',
      '**/target/**',
      '**/coverage/**',
      '**/.terraform/**',
      '**/.dart_tool/**',
      '**/bin/**',
      '**/obj/**',
      '**/vendor/**',
      '**/vendors/**',
      '**/third_party/**',
      '**/third-party/**',
      '**/*_extracted/**',
      '**/*-extracted/**',
      '**/examples/**',
      '**/samples/**',
      '**/venv/**',
      '**/.venv/**',
      '**/env/**',
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
    ],
    nodir: true,
  });
  const entryFileSet = new Set(entryFiles);
  const nodesByFile = buildNodesByFile(cas);
  const safeCandidates = [...sourceFiles, ...entryFiles]
    .filter(file => file && !isTestFile(file) && !isUnsafeBenchmarkEditFile(file))
    .filter((file, index, values) => values.indexOf(file) === index)
    .map(file => ({ file, score: incrementalEditScore(cas, file, entryFileSet, nodesByFile), nodeCount: (nodesByFile.get(file) || []).length }))
    .filter(candidate => candidate.nodeCount > 0)
    .sort((left, right) => right.score - left.score)
    .map(candidate => candidate.file);
  const fallbackCandidates = [...sourceFiles, ...entryFiles]
    .filter(file => file && !isTestFile(file) && !isGeneratedBenchmarkFile(file))
    .filter((file, index, values) => values.indexOf(file) === index)
    .map(file => ({ file, score: incrementalEditScore(cas, file, entryFileSet, nodesByFile), nodeCount: (nodesByFile.get(file) || []).length }))
    .filter(candidate => candidate.nodeCount > 0)
    .sort((left, right) => right.score - left.score)
    .map(candidate => candidate.file);
  const candidates = safeCandidates.length > 0 ? safeCandidates : fallbackCandidates;

  for (const file of candidates) {
    const absolute = path.join(workspace, file);
    if (await fs.pathExists(absolute)) {
      const stat = await fs.stat(absolute);
      if (stat.size > 0 && stat.size < 500_000) return file;
    }
  }
  return null;
}

function buildNodesByFile(cas: IncrementalAnalysisResult['output']): Map<string, typeof cas.nodes> {
  const nodesByFile = new Map<string, typeof cas.nodes>();
  for (const node of cas.nodes) {
    const sourceFile = node.source?.file;
    if (!sourceFile) continue;
    const relative = path.isAbsolute(sourceFile) ? path.relative(cas.system.root_path, sourceFile) : sourceFile;
    const normalized = relative.replace(/\\/g, '/');
    if (!nodesByFile.has(normalized)) nodesByFile.set(normalized, []);
    nodesByFile.get(normalized)!.push(node);
  }
  return nodesByFile;
}

function incrementalEditScore(
  cas: IncrementalAnalysisResult['output'],
  file: string,
  entryFiles: Set<string>,
  nodesByFile: Map<string, typeof cas.nodes>
): number {
  let score = 50;
  if (entryFiles.has(file)) score -= 35;
  if (/controller|route|page|module|provider|guard|middleware|schema|migration|entity|model|generated|graphql|openapi/i.test(file)) score -= 30;
  if (/utils?|helpers?|constants?|types?|lib|shared/i.test(file)) score += 20;
  const nodes = nodesByFile.get(file) || [];
  if (nodes.length === 0) return score - 10;
  const unsafeAnalyzers = nodes.flatMap(node => [
    ...(node.analyzers || []),
    ...(node.primaryAnalyzer ? [node.primaryAnalyzer] : []),
  ]).filter(analyzer => analyzer && !INCREMENTAL_SAFE_ANALYZERS.has(analyzer));
  if (unsafeAnalyzers.length === 0) score += 45;
  else score -= Math.min(60, unsafeAnalyzers.length * 15);
  return score;
}

function isUnsafeBenchmarkEditFile(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  const basename = path.basename(normalized);
  if (/\.d\.ts$/i.test(basename)) return true;
  if (/^(vite|webpack|rollup|next|nuxt|svelte|astro|jest|vitest|cypress|playwright|eslint|prettier|babel|postcss|tailwind)\.config\.[cm]?[jt]s$/i.test(basename)) return true;
  if (/^(jest|vitest|cypress|playwright|eslint|prettier|babel|postcss|tailwind)\.preset\.[cm]?[jt]s$/i.test(basename)) return true;
  if (/^(package|tsconfig|jsconfig|composer|pubspec|Cargo|go|pom|build\.gradle|requirements|pyproject|setup)\b/i.test(basename)) return true;
  if (/^(package-lock|pnpm-lock|yarn\.lock|Cargo\.lock|composer\.lock|go\.sum)$/i.test(basename)) return true;
  if (/^(manage|main|index)\.(py|ts|tsx|js|jsx|mjs|cjs)$/i.test(basename)) return true;
  if (/(^|\/)(cas-tests?|codemods?|database|db|fixtures?|migrations?|schemas?|seeders?|seeds?|scripts?|tools?|types)(\/|$)/i.test(normalized)) return true;
  if (/(^|\/)(soap|wsdl|generated-client|api-client|sdk-client)(\/|$)/i.test(normalized)) return true;
  if (/^(ws[A-Z0-9]|.*(?:Request|Response|Array|Dto|DTO))\.(?:php|cs|java|ts)$/i.test(basename)) return true;
  if (/(database-client|db-client|generated-client|api-client|sdk-client|repository|migration|schema|entity|model|seeder|seed|fixture|fix-all|codemod)\.[cm]?[jt]sx?$/i.test(basename)) return true;
  if (isGeneratedBenchmarkFile(normalized)) return true;
  return false;
}

function isGeneratedBenchmarkFile(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  if (/(^|\/)(generated|Generated|dist|build|target|vendor|vendors)(\/|$)/.test(normalized)) return true;
  if (/(^|\/)(third_party|third-party|examples|samples)(\/|$)/i.test(normalized)) return true;
  if (/(^|\/)[^/]+(?:_|-)extracted(\/|$)/i.test(normalized)) return true;
  if (/\.(?:map|min|bundle)\.(?:js|css)$/i.test(normalized) || /\.(?:js|css)\.map$/i.test(normalized)) return true;
  return false;
}

function targetFromEditedFile(cas: IncrementalAnalysisResult['output'], editedFile: string): string {
  const normalizedEditedFile = editedFile.replace(/\\/g, '/');
  const exactNode = cas.nodes.find(candidate => {
    const file = candidate.source?.file;
    if (!file) return false;
    const normalized = (path.isAbsolute(file) ? path.relative(cas.system.root_path, file) : file).replace(/\\/g, '/');
    return normalized === normalizedEditedFile;
  });
  if (exactNode) return normalizedEditedFile;

  const node = cas.nodes.find(candidate => {
    const file = candidate.source?.file;
    if (!file) return false;
    const normalized = (path.isAbsolute(file) ? path.relative(cas.system.root_path, file) : file).replace(/\\/g, '/');
    return normalized.endsWith(`/${normalizedEditedFile}`);
  });
  return node?.name || path.basename(editedFile);
}

function isTestFile(file: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec)\//i.test(file) ||
    /\.(test|spec|cy)\./i.test(file) ||
    /(_test|Test|Tests)\.(go|java|cs|py)$/i.test(file);
}

const INCREMENTAL_SAFE_ANALYZERS = new Set([
  'typescript-javascript',
  'python',
  'rust',
  'go',
  'java',
  'csharp',
  'php',
  'dart',
  'terraform',
]);

async function applySafeSourceEdit(filePath: string): Promise<IncrementalTargetReport['edit']> {
  const content = await fs.readFile(filePath, 'utf-8');
  const extension = path.extname(filePath).toLowerCase();
  const probe = sourceProbeForExtension(extension);
  await new Promise(resolve => setTimeout(resolve, 5));
  if (probe) {
    await fs.writeFile(filePath, `${trimTrailingWhitespace(content)}\n\n${probe}\n`, 'utf-8');
    return { kind: 'syntactic-probe', detail: `appended ${extension || 'source'} comment probe` };
  }
  await fs.writeFile(filePath, `${content}\n`, 'utf-8');
  return { kind: 'whitespace-fallback', detail: 'appended newline because no language probe is defined for this extension' };
}

function sourceProbeForExtension(extension: string): string | null {
  switch (extension) {
    case '.ts':
    case '.tsx':
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return '// analysis probe: cas-edit-loop';
    case '.py':
      return '# analysis probe: cas-edit-loop';
    case '.rs':
      return '// analysis probe: cas-edit-loop';
    case '.go':
      return '// analysis probe: cas-edit-loop';
    case '.java':
      return '// analysis probe: cas-edit-loop';
    case '.cs':
      return '// analysis probe: cas-edit-loop';
    case '.php':
      return '// analysis probe: cas-edit-loop';
    case '.dart':
      return '// analysis probe: cas-edit-loop';
    case '.tf':
    case '.tfvars':
      return '# analysis probe: cas-edit-loop';
    default:
      return null;
  }
}

function trimTrailingWhitespace(content: string): string {
  return content.replace(/\s+$/u, '');
}

function compareCasCounts(incremental: IncrementalAnalysisResult['output'], full: IncrementalAnalysisResult['output']) {
  const nodeDelta = Math.abs(incremental.nodes.length - full.nodes.length);
  const edgeDelta = Math.abs(incremental.edges.length - full.edges.length);
  const entryPointDelta = Math.abs((incremental.entry_points?.length || 0) - (full.entry_points?.length || 0));
  const exitPointDelta = Math.abs((incremental.exit_points?.length || 0) - (full.exit_points?.length || 0));
  const baseline = Math.max(
    1,
    full.nodes.length + full.edges.length + (full.entry_points?.length || 0) + (full.exit_points?.length || 0)
  );
  const delta = nodeDelta + edgeDelta + entryPointDelta + exitPointDelta;
  return {
    node_delta: nodeDelta,
    edge_delta: edgeDelta,
    entry_point_delta: entryPointDelta,
    exit_point_delta: exitPointDelta,
    absolute_delta: delta,
    count_similarity: Number(Math.max(0, 1 - delta / baseline).toFixed(4)),
  };
}

async function copyRepo(source: string, destination: string): Promise<void> {
  const method = process.env.KLAURO_INCREMENTAL_COPY_METHOD || 'fs';
  if (method === 'apfs' && await copyRepoWithApfsClone(source, destination)) return;
  if (method === 'rsync' && await copyRepoWithRsync(source, destination)) return;
  await fs.copy(source, destination, {
    filter: file => {
      const relative = path.relative(source, file);
      if (!relative) return true;
      const normalized = relative.replace(/\\/g, '/');
      if (isBenchmarkCopyExcludedPath(normalized)) {
        return false;
      }
      if (/\.(?:map|bundle|min)\.(?:js|css)$/i.test(normalized) || /\.(?:js|css)\.map$/i.test(normalized)) {
        return false;
      }
      const parts = normalized.split('/');
      return !parts.some(part => [
        '.git',
        '.claude',
        '.codex',
        '.scannerwork',
        'node_modules',
        'vendor',
        'vendors',
        'third_party',
        'third-party',
        'examples',
        'samples',
        '.venv',
        'venv',
        'env',
        'site-packages',
        '__pycache__',
        '.pytest_cache',
        '.mypy_cache',
        '.ruff_cache',
        '.cache',
        '.sourcemaps',
        'sourcemaps',
        'dist',
        'build',
        'target',
        'coverage',
        '.next',
        '.turbo',
        '.dart_tool',
        '.gradle',
        'bin',
        'obj',
        'Pods',
        'Generated',
        'generated',
        '.klauro-agent-home',
        '.klauro-agent-benchmark',
        '.klauro-agent-quality-benchmark',
        '.klauro-agent-vision-acceptance',
        '.klauro-agent-live-trials',
        '.klauro-incremental-benchmark',
      ].includes(part) || /(?:_|-)extracted$/i.test(part));
    },
  });
}

async function copyRepoWithApfsClone(source: string, destination: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  if (await hasHeavyExcludedDirectory(source)) return false;
  try {
    await fs.ensureDir(destination);
    execFileSync('cp', [
      '-cR',
      `${path.resolve(source).replace(/\/$/, '')}/.`,
      path.resolve(destination),
    ], {
      stdio: 'ignore',
      maxBuffer: 1024 * 1024 * 50,
    });
    await removeCopiedBenchmarkArtifacts(destination);
    return true;
  } catch {
    await fs.remove(destination).catch(() => undefined);
    return false;
  }
}

async function hasHeavyExcludedDirectory(source: string): Promise<boolean> {
  const heavyDirs = [
    'node_modules',
    '.venv',
    'venv',
    'env',
    'site-packages',
    'vendor',
    'vendors',
    'target',
    'dist',
    'build',
    '.next',
    '.turbo',
    '.dart_tool',
    '.gradle',
    'Pods',
  ];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: source, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= 3) continue;
    let entries: string[] = [];
    try {
      entries = await fs.readdir(current.dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === '.git' || entry === '.klauro' || entry.startsWith('.klauro-')) continue;
      const fullPath = path.join(current.dir, entry);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      if (heavyDirs.includes(entry)) return true;
      queue.push({ dir: fullPath, depth: current.depth + 1 });
    }
  }
  return false;
}

async function removeCopiedBenchmarkArtifacts(destination: string): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(destination);
  } catch {
    return;
  }
  await Promise.all(entries
    .filter(entry => entry === '.git' || entry === '.claude' || entry === '.codex' || entry === '.scannerwork' || entry === '.klauro' || entry.startsWith('.klauro-'))
    .map(entry => fs.remove(path.join(destination, entry)).catch(() => undefined)));
}

async function copyRepoWithRsync(source: string, destination: string): Promise<boolean> {
  try {
    await fs.ensureDir(destination);
    execFileSync('rsync', [
      '-a',
      '--delete',
      ...rsyncExcludeArgs(),
      `${path.resolve(source).replace(/\/$/, '')}/`,
      `${path.resolve(destination).replace(/\/$/, '')}/`,
    ], {
      stdio: 'ignore',
      maxBuffer: 1024 * 1024 * 50,
    });
    return true;
  } catch {
    await fs.remove(destination).catch(() => undefined);
    return false;
  }
}

function rsyncExcludeArgs(): string[] {
  return [
    '.git/',
    '.claude/',
    '.codex/',
    '.scannerwork/',
    'node_modules/',
    'vendor/',
    'vendors/',
    'third_party/',
    'third-party/',
    'examples/',
    'samples/',
    '.venv/',
    'venv/',
    'env/',
    'site-packages/',
    '__pycache__/',
    '.pytest_cache/',
    '.mypy_cache/',
    '.ruff_cache/',
    '.cache/',
    '.sourcemaps/',
    'sourcemaps/',
    'dist/',
    'build/',
    'target/',
    'coverage/',
    '.next/',
    '.turbo/',
    '.dart_tool/',
    '.gradle/',
    'bin/',
    'obj/',
    'Pods/',
    'Generated/',
    'generated/',
    '.klauro*/',
    '.klauro-agent-home/',
    '.klauro-agent-benchmark/',
    '.klauro-agent-quality-benchmark/',
    '.klauro-agent-vision-acceptance/',
    '.klauro-agent-live-trials/',
    '.klauro-incremental-benchmark/',
    '*_extracted/',
    '*-extracted/',
    '*.png',
    '*.jpg',
    '*.jpeg',
    '*.gif',
    '*.webp',
    '*.avif',
    '*.mp3',
    '*.mp4',
    '*.mov',
    '*.wav',
    '*.flac',
    '*.ogg',
    '*.zip',
    '*.tar',
    '*.tgz',
    '*.gz',
    '*.7z',
    '*.rar',
    '*.pdf',
    '*.dmg',
    '*.bin',
    '*.a',
    '*.so',
    '*.dylib',
    '*.dll',
    '*.exe',
    '*.pdb',
    '*.nupkg',
    '*.onnx',
    '*.pt',
    '*.pth',
    '*.safetensors',
    '*.ckpt',
    '*.map',
    '*.min.js',
    '*.min.css',
    '*.bundle.js',
    '*.bundle.css',
    'packages/FreeSpire.*/',
    'packages/Spire.*/',
    'packages/System.*/',
    'packages/Microsoft.*/',
    'packages/NETStandard.*/',
    'packages/Newtonsoft.*/',
    'packages/Grpc.*/',
    'packages/runtime.*/',
    'packages/NETCore.*/',
    'packages/EntityFramework.*/',
    'checkpoints/',
    'hf_cache/',
    'huggingface/',
    'model_cache/',
    'models--nvidia--bigvgan_v2_44khz_128band_512x/',
    'blobs/',
    'Garments/',
    'garments/',
    '.DS_Store',
  ].flatMap(pattern => ['--exclude', pattern]);
}

export function isBenchmarkCopyExcludedPath(normalized: string): boolean {
  const basename = path.basename(normalized);
  if (basename === '.DS_Store') return true;
  if (/\.(?:png|jpe?g|gif|webp|avif|mp[34]|mov|wav|flac|ogg|zip|tar|tgz|gz|7z|rar|pdf|dmg|bin|a|so|dylib|dll|exe|pdb|nupkg|onnx|pt|pth|safetensors|ckpt)$/i.test(basename)) {
    return true;
  }

  const parts = normalized.split('/');
  if (parts.some(part => [
    'checkpoints',
    'hf_cache',
    'huggingface',
    'model_cache',
    'models--nvidia--bigvgan_v2_44khz_128band_512x',
    'blobs',
    'Garments',
    'garments',
  ].includes(part))) {
    return true;
  }

  const packagesIndex = parts.findIndex(part => part.toLowerCase() === 'packages');
  if (packagesIndex >= 0) {
    const packageName = parts[packagesIndex + 1] || '';
    if (/^(?:FreeSpire|Spire|System|Microsoft|NETStandard|Newtonsoft|Grpc|runtime\.|NETCore|EntityFramework)\./i.test(packageName)) {
      return true;
    }
  }

  return false;
}

function initializeBenchmarkGitBaseline(workspace: string): void {
  execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore', maxBuffer: 1024 * 1024 * 50 });
  execFileSync('git', ['add', '.'], { cwd: workspace, stdio: 'ignore', maxBuffer: 1024 * 1024 * 50 });
  execFileSync('git', ['commit', '-m', 'incremental benchmark baseline'], {
    cwd: workspace,
    env: gitEnv(),
    stdio: 'ignore',
    maxBuffer: 1024 * 1024 * 50,
  });
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Klauro Benchmark',
    GIT_AUTHOR_EMAIL: 'benchmark@klauro.local',
    GIT_COMMITTER_NAME: 'Klauro Benchmark',
    GIT_COMMITTER_EMAIL: 'benchmark@klauro.local',
  };
}

interface Timed<T> {
  value: T;
  durationMs: number;
}

async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const startedAt = Date.now();
  const value = await fn();
  return { value, durationMs: Math.max(1, Date.now() - startedAt) };
}

function gate(id: string, passed: boolean, detail: string) {
  return {
    id,
    status: passed ? 'pass' as GateStatus : 'fail' as GateStatus,
    score: passed ? 100 : 0,
    detail,
  };
}

function softGate(id: string, passed: boolean, detail: string) {
  return {
    id,
    status: passed ? 'pass' as GateStatus : 'warn' as GateStatus,
    score: passed ? 100 : 90,
    detail,
  };
}

function summarizeCasDelta(result: IncrementalAnalysisResult): number {
  const summary = result.changeReport.summary;
  return summary.nodesAdded + summary.nodesModified + summary.nodesDeleted;
}

function parityGate(parity: NonNullable<IncrementalTargetReport['full_verify_parity']>) {
  const detail = `${Math.round(parity.count_similarity * 100)}% count similarity, ${parity.absolute_delta} absolute count delta`;
  if (parity.count_similarity >= 0.98 || parity.absolute_delta <= 8) {
    return { id: 'incremental-full-count-parity', status: 'pass' as GateStatus, score: 100, detail };
  }
  if (parity.count_similarity >= 0.94 || parity.absolute_delta <= 20) {
    return { id: 'incremental-full-count-parity', status: 'warn' as GateStatus, score: 80, detail };
  }
  return { id: 'incremental-full-count-parity', status: 'fail' as GateStatus, score: 0, detail };
}

function aggregateStatus(statuses: GateStatus[]): GateStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

function statusFromScore(score: number): GateStatus {
  if (score >= 90) return 'pass';
  if (score >= 70) return 'warn';
  return 'fail';
}

function average(values: number[]): number {
  if (values.length === 0) return 100;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratio(baseline: number, actual: number): number {
  if (actual <= 0) return baseline > 0 ? baseline : 1;
  return Number((baseline / actual).toFixed(2));
}

async function estimatePostEditTokenProof(
  workspace: string,
  context: Awaited<ReturnType<typeof getAgentContext>>,
  editFile: string
) {
  const sourceFiles = await sourceFileStats(workspace);
  const sourceTokensByFile = new Map(sourceFiles.map(file => [file.file, file.estimated_tokens]));
  const contextTokens = estimateTokens(JSON.stringify(context).length);
  const plannedSourceTokens = context.file_read_plan.reduce((total, item: any) => {
    const file = String(item.file || '');
    const stat = findCompatibleSourceStat(sourceFiles, file);
    if (!stat) return total;
    return total + estimateLineWindowTokens(workspace, file, item.line_window, stat.estimated_tokens);
  }, 0);
  const totalContextTokens = contextTokens + plannedSourceTokens;
  const searchFiles = searchBaselineFiles(sourceFiles, editFile, context);
  const searchBaselineTokens = searchFiles.reduce((total, file) => total + (sourceTokensByFile.get(file.file) || file.estimated_tokens), 0) +
    estimateSearchOverheadTokens(sourceFiles.length, searchFiles.length);
  const coldScanTokens = sourceFiles.reduce((total, file) => total + file.estimated_tokens, 0);

  return {
    estimated_source_tokens: plannedSourceTokens,
    estimated_total_context_tokens: totalContextTokens,
    estimated_search_baseline_tokens: searchBaselineTokens,
    estimated_search_token_reduction_percentage: percentReduction(searchBaselineTokens, totalContextTokens),
    estimated_cold_scan_tokens: coldScanTokens,
    estimated_cold_scan_token_reduction_percentage: percentReduction(coldScanTokens, totalContextTokens),
  };
}

async function sourceFileStats(workspace: string): Promise<Array<{ file: string; estimated_tokens: number }>> {
  const files = await glob(['**/*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,cs,php,dart,prisma,tf,tfvars}'], {
    cwd: workspace,
    ignore: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.git/**',
      '**/.terraform/**',
      '**/target/**',
      '**/coverage/**',
      '**/.dart_tool/**',
      '**/bin/**',
      '**/obj/**',
      '**/vendor/**',
      '**/vendors/**',
      '**/third_party/**',
      '**/third-party/**',
      '**/*_extracted/**',
      '**/*-extracted/**',
      '**/examples/**',
      '**/samples/**',
      '**/Generated/**',
      '**/generated/**',
      '**/*.min.js',
      '**/*.bundle.js',
      '**/*.map',
    ],
    nodir: true,
  });
  const stats: Array<{ file: string; estimated_tokens: number }> = [];
  for (const file of files.sort()) {
    try {
      const stat = await fs.stat(path.join(workspace, file));
      stats.push({ file, estimated_tokens: estimateTokens(stat.size) });
    } catch {
      // Ignore files that disappear during copied-workspace cleanup or generated churn.
    }
  }
  return stats;
}

function findCompatibleSourceStat(sourceFiles: Array<{ file: string; estimated_tokens: number }>, file: string) {
  const normalized = normalizeComparablePath(file);
  return sourceFiles.find(candidate => {
    const candidatePath = normalizeComparablePath(candidate.file);
    return candidatePath === normalized ||
      candidatePath.endsWith(`/${normalized}`) ||
      normalized.endsWith(`/${candidatePath}`);
  });
}

function estimateLineWindowTokens(workspace: string, file: string, lineWindow: any, fallbackTokens: number): number {
  if (!lineWindow?.start || !lineWindow?.end || lineWindow.end < lineWindow.start) return fallbackTokens;
  try {
    const lines = fs.readFileSync(path.resolve(workspace, file), 'utf8').split(/\r?\n/);
    const start = Math.max(0, Math.floor(lineWindow.start) - 1);
    const end = Math.min(lines.length, Math.floor(lineWindow.end));
    if (start >= end) return fallbackTokens;
    return Math.min(fallbackTokens, Math.max(1, estimateTokens(lines.slice(start, end).join('\n').length)));
  } catch {
    return fallbackTokens;
  }
}

function searchBaselineFiles(
  sourceFiles: Array<{ file: string; estimated_tokens: number }>,
  editFile: string,
  context: Awaited<ReturnType<typeof getAgentContext>>
) {
  const targetText = [
    editFile,
    context.selected_node && typeof context.selected_node === 'object' ? JSON.stringify(context.selected_node) : '',
  ].join(' ');
  const tokens = meaningfulSearchTokens(targetText);
  const configFiles = sourceFiles.filter(file => /(^|\/)(package\.json|tsconfig|pyproject|go\.mod|cargo\.toml|composer\.json|pubspec\.yaml|readme)/i.test(file.file));
  const matched = sourceFiles.filter(file => {
    const normalized = file.file.toLowerCase();
    return tokens.some(token => normalized.includes(token));
  });
  const selected = [...configFiles, ...matched]
    .filter((file, index, values) => values.findIndex(candidate => candidate.file === file.file) === index);
  return selected.length > 0 ? selected : sourceFiles;
}

function meaningfulSearchTokens(value: string): string[] {
  return [...new Set(value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(token => token.length >= 4 && !new Set(['file', 'line', 'type', 'name', 'source', 'function', 'class']).has(token))
  )].slice(0, 12);
}

function estimateSearchOverheadTokens(sourceFileCount: number, matchedFileCount: number): number {
  return Math.min(50000, Math.max(2000, sourceFileCount * 120)) + matchedFileCount * 600 + 1000;
}

function percentReduction(baseline: number, actual: number): number {
  if (baseline <= 0) return actual <= 0 ? 100 : 0;
  return Math.round(((baseline - actual) / baseline) * 100);
}

function normalizeComparablePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function estimateTokens(size: number): number {
  return Math.max(1, Math.ceil(size / 4));
}

function slugify(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 80) || 'target';
}

async function withQuietLogs<T>(quiet: boolean, fn: () => Promise<T>): Promise<T> {
  if (!quiet) return fn();
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    return await fn();
  } finally {
    console.log = originalLog;
  }
}

export function formatIncrementalValueMarkdownReport(report: Awaited<ReturnType<typeof runIncrementalValueBenchmark>>): string {
  const lines = [
    '# Klauro Incremental Analysis Benchmark',
    '',
    `Generated: ${report.generated_at}`,
    `Status: ${report.status}`,
    `Score: ${report.score}/100`,
    `Benchmark type: ${report.benchmark_type}`,
    '',
    '## Executive Summary',
    '',
    `Targets: ${report.summary.target_count}`,
    `Incremental success rate: ${Math.round(report.summary.incremental_success_rate * 100)}%`,
    `Average initial full analysis: ${report.summary.average_initial_full_ms}ms`,
    `Average no-change incremental analysis: ${report.summary.average_no_change_incremental_ms}ms`,
    `Average edit incremental analysis: ${report.summary.average_edit_incremental_ms}ms`,
    `Average edit-loop wall time: ${report.summary.average_edit_loop_wall_ms}ms`,
    `Average target wall time: ${report.summary.average_total_wall_ms}ms`,
    `Average non-analysis overhead: ${report.summary.average_non_analysis_overhead_ms}ms`,
    `Average no-change speedup vs full: ${report.summary.average_no_change_speedup_vs_full}x`,
    `Average edit speedup vs full: ${report.summary.average_edit_speedup_vs_full}x`,
    `Average agent context generation after edit: ${report.summary.average_context_generation_ms_after_edit}ms`,
    `Average file-read plan after edit: ${report.summary.average_file_read_plan_after_edit} files`,
    `Average context size after edit: ${report.summary.average_context_tokens_after_edit} estimated tokens`,
    `Average total context after edit: ${report.summary.average_total_context_tokens_after_edit} estimated tokens`,
    `Average search baseline after edit: ${report.summary.average_search_baseline_tokens_after_edit} estimated tokens`,
    `Average token reduction vs search after edit: ${report.summary.average_search_token_reduction_after_edit}%`,
    `Average token reduction vs cold scan after edit: ${report.summary.average_cold_scan_token_reduction_after_edit}%`,
    `Average full-verify count similarity: ${Math.round(report.summary.average_full_verify_count_similarity * 100)}%`,
    '',
    '## Repository Summary',
    '',
    '| Repo | Status | Score | Edited file | Wall ms | Edit-loop ms | Full ms | Edit incremental ms | Overhead ms | Speedup | Changed files | Context files | Token reduction | Parity |',
    '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const target of report.targets) {
    lines.push(`| ${target.name} | ${target.status} | ${target.score} | ${target.edited_file || ''} | ${target.timings.total_wall_ms || ''} | ${target.timings.edit_loop_wall_ms || ''} | ${target.timings.initial_full_ms} | ${target.timings.edit_incremental_ms} | ${nonAnalysisOverheadMs(target.timings)} | ${target.speedups.edit_incremental_vs_full}x | ${target.change_summary.files_changed} | ${target.agent_value_after_edit.file_read_plan_count} | ${target.agent_value_after_edit.estimated_search_token_reduction_percentage}% | ${target.full_verify_parity ? `${Math.round(target.full_verify_parity.count_similarity * 100)}%` : 'not run'} |`);
  }

  lines.push('', '## Target Details', '');
  for (const target of report.targets) {
    lines.push(`### ${target.name}`, '');
    lines.push(`Workspace: ${target.workspace}`);
    lines.push(`Edited file: ${target.edited_file || 'none'}`);
    lines.push(`Edit: ${target.edit.kind} (${target.edit.detail})`);
    lines.push(`Timings: wall ${target.timings.total_wall_ms || 'unknown'}ms, edit-loop wall ${target.timings.edit_loop_wall_ms || 'unknown'}ms, full ${target.timings.initial_full_ms}ms, no-change incremental ${target.timings.no_change_incremental_ms}ms, edit incremental ${target.timings.edit_incremental_ms}ms, non-analysis overhead ${nonAnalysisOverheadMs(target.timings)}ms${target.timings.verify_full_after_edit_ms ? `, verify full ${target.timings.verify_full_after_edit_ms}ms` : ''}.`);
    lines.push(`Change summary: ${target.change_summary.files_changed} files changed, ${target.change_summary.nodes_added} nodes added, ${target.change_summary.nodes_modified} nodes modified, ${target.change_summary.nodes_deleted} nodes deleted, risk ${target.change_summary.risk_level}.`);
    lines.push(`Agent context after edit: ${target.agent_value_after_edit.file_read_plan_count} files, ${target.agent_value_after_edit.next_mcp_calls} MCP calls, ${target.agent_value_after_edit.estimated_total_context_tokens} estimated total context tokens (${target.agent_value_after_edit.estimated_context_tokens} context + ${target.agent_value_after_edit.estimated_source_tokens} source), ${target.agent_value_after_edit.estimated_search_token_reduction_percentage}% token reduction vs search, ${target.agent_value_after_edit.context_generation_ms}ms.`);
    lines.push(`Gates: ${target.gates.map(gate => `${gate.id}=${gate.status}`).join(', ')}`);
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runIncrementalValueBenchmark({
    repos: args.repos,
    includeRealRepos: args.includeRealRepos,
    devRoot: args.devRoot,
    maxTargets: args.maxTargets,
    workRoot: args.workRoot,
    keepWorkspaces: args.keepWorkspaces,
    verifyFull: args.verifyFull,
    useGitBaseline: args.useGitBaseline,
    concurrency: args.concurrency,
    analysisPath: args.analysisPath,
  });

  await fs.ensureDir(path.dirname(args.outputPath));
  await fs.writeJson(args.outputPath, report, { spaces: 2 });
  await fs.ensureDir(path.dirname(args.markdownPath));
  await fs.writeFile(args.markdownPath, formatIncrementalValueMarkdownReport(report), 'utf8');
  const saved = await saveAgenticBenchmarkReport(report);
  console.log(`Incremental analysis benchmark: ${report.status.toUpperCase()} (${report.score}/100)`);
  console.log(`Targets: ${report.summary.target_count} | Incremental success ${Math.round(report.summary.incremental_success_rate * 100)}% | Edit speedup ${report.summary.average_edit_speedup_vs_full}x | Context ${report.summary.average_context_generation_ms_after_edit}ms/${report.summary.average_context_tokens_after_edit} tokens | Token reduction ${report.summary.average_search_token_reduction_after_edit}% vs search`);
  for (const target of report.targets) {
    console.log(`${target.status.toUpperCase().padEnd(4)} ${String(target.score).padStart(3)}/100 | ${target.name} | ${target.edited_file || 'no edit'} | ${target.timings.total_wall_ms || 'unknown'}ms wall | ${target.timings.edit_loop_wall_ms || 'unknown'}ms edit loop | ${target.timings.initial_full_ms}ms full | ${target.timings.edit_incremental_ms}ms edit incr | ${target.speedups.edit_incremental_vs_full}x | context ${target.agent_value_after_edit.file_read_plan_count} files`);
  }
  console.log(`Report: ${args.outputPath}`);
  console.log(`Markdown: ${args.markdownPath}`);
  console.log(`Persisted MCP report: ${saved.file}`);
  if (report.status === 'fail') process.exitCode = 1;
}

if (isDirectCliInvocation('incremental-benchmark')) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
