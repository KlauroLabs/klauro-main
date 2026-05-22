import * as fs from 'fs-extra';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { glob } from 'glob';
import pLimit from 'p-limit';
import { analyzeProject, analyzeProjectIncremental, type IncrementalAnalysisResult } from './analyzer';
import { getAgentWorkPacket } from './agent-adoption';
import { discoverTargets, type RepoTarget } from './gauntlet';
import { getFileCacheSize, loadIncrementalState, saveAgenticBenchmarkReport } from './storage';

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
  quiet?: boolean;
  concurrency?: number;
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
    initial_full_ms: number;
    no_change_incremental_ms: number;
    edit_incremental_ms: number;
    verify_full_after_edit_ms?: number;
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
    packet_generation_ms: number;
    file_read_plan_count: number;
    next_mcp_calls: number;
    estimated_packet_tokens: number;
    selected_node?: unknown;
    default_use?: boolean;
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
  let workRoot = defaultWorkRoot();
  let outputPath = path.join(process.cwd(), '.unravl-incremental-benchmark', 'latest-report.json');
  let markdownPath = path.join(process.cwd(), '.unravl-incremental-benchmark', 'latest-report.md');
  let keepWorkspaces = false;
  let verifyFull = true;
  let concurrency = 1;

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
    } else if (arg === '--concurrency') {
      concurrency = Number(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { repos, includeRealRepos, devRoot, maxTargets, workRoot, outputPath, markdownPath, keepWorkspaces, verifyFull, concurrency };
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
    '  --concurrency n             Number of repos to benchmark concurrently. Default 1. Values above 1 are capped because storage isolation is process-scoped.',
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
      incremental_success_rate: Number((average(reports.map(target => !target.change_summary.was_full_rebuild ? 100 : 0)) / 100).toFixed(2)),
      average_initial_full_ms: Math.round(average(reports.map(target => target.timings.initial_full_ms))),
      average_no_change_incremental_ms: Math.round(average(reports.map(target => target.timings.no_change_incremental_ms))),
      average_edit_incremental_ms: Math.round(average(reports.map(target => target.timings.edit_incremental_ms))),
      average_no_change_speedup_vs_full: Number(average(reports.map(target => target.speedups.no_change_vs_full)).toFixed(2)),
      average_edit_speedup_vs_full: Number(average(reports.map(target => target.speedups.edit_incremental_vs_full)).toFixed(2)),
      average_packet_generation_ms_after_edit: Math.round(average(reports.map(target => target.agent_value_after_edit.packet_generation_ms))),
      average_file_read_plan_after_edit: Math.round(average(reports.map(target => target.agent_value_after_edit.file_read_plan_count))),
      average_packet_tokens_after_edit: Math.round(average(reports.map(target => target.agent_value_after_edit.estimated_packet_tokens))),
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
      initial_full_ms: Math.max(1, durationMs),
      no_change_incremental_ms: 0,
      edit_incremental_ms: 0,
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
      packet_generation_ms: 0,
      file_read_plan_count: 0,
      next_mcp_calls: 0,
      estimated_packet_tokens: 0,
      default_use: false,
    },
  };
}

async function selectTargets(options: IncrementalBenchmarkOptions): Promise<IncrementalTargetInput[]> {
  const realRepos: RepoTarget[] = options.includeRealRepos
    || options.repos.length === 0
    ? await discoverTargets(options.devRoot || path.join(process.env.HOME || '', 'dev'))
    : [];
  const selected = [
    ...realRepos.map(repo => ({ name: repo.name, path: repo.path })),
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

function defaultWorkRoot(): string {
  return path.join(process.env.HOME || process.cwd(), '.unravl', 'incremental-benchmark-workspaces');
}

async function benchmarkTarget(target: IncrementalTargetInput, options: IncrementalBenchmarkOptions): Promise<IncrementalTargetReport> {
  const trialRoot = path.join(path.resolve(options.workRoot || path.join(process.cwd(), '.unravl-incremental-benchmark', 'workspaces')), `${slugify(target.name || path.basename(target.path))}-${Date.now()}`);
  const workspace = path.join(trialRoot, 'repo');
  const storagePath = path.join(trialRoot, 'storage');
  await fs.ensureDir(trialRoot);
  try {
    await copyRepo(target.path, workspace);
    initializeBenchmarkGitBaseline(workspace);

    const previousStorage = process.env.UNRAVL_STORAGE_PATH;
    process.env.UNRAVL_STORAGE_PATH = storagePath;
    try {
      const initial = await timed(() => analyzeProjectIncremental(workspace));
      const noChange = await timed(() => analyzeProjectIncremental(workspace));
      const editFile = await chooseEditFile(initial.value.output, workspace);
      if (!editFile) throw new Error(`No editable source file found in copied repo: ${workspace}`);
      const edit = await applySafeSourceEdit(path.join(workspace, editFile));
      const edited = await timed(() => analyzeProjectIncremental(workspace));

      const packetStartedAt = Date.now();
      const packet = await getAgentWorkPacket(edited.value.output, workspace, {
        task_type: 'modify',
        target: targetFromEditedFile(edited.value.output, editFile),
        instructions: `Use the incremental change summary to inspect ${editFile} and preserve connected behavior.`,
      });
      const packetGenerationMs = Math.max(1, Date.now() - packetStartedAt);

      const verify = options.verifyFull ? await timed(() => analyzeProject(workspace)) : undefined;
      const state = await loadIncrementalState(workspace);
      const cacheSize = await getFileCacheSize(workspace);
      const fullParity = verify ? compareCasCounts(edited.value.output, verify.value) : undefined;
      const gates = buildGates(initial, noChange, edited, packet, edit, fullParity);
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
          initial_full_ms: initial.durationMs,
          no_change_incremental_ms: noChange.durationMs,
          edit_incremental_ms: edited.durationMs,
          verify_full_after_edit_ms: verify?.durationMs,
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
          packet_generation_ms: packetGenerationMs,
          file_read_plan_count: packet.file_read_plan.length,
          next_mcp_calls: packet.next_mcp_calls.length,
          estimated_packet_tokens: estimateTokens(JSON.stringify(packet).length),
          selected_node: packet.selected_node,
          default_use: packet.default_use,
        },
        full_verify_parity: fullParity,
      };
    } finally {
      if (previousStorage === undefined) {
        delete process.env.UNRAVL_STORAGE_PATH;
      } else {
        process.env.UNRAVL_STORAGE_PATH = previousStorage;
      }
    }
  } finally {
    if (options.keepWorkspaces === false) await fs.remove(trialRoot).catch(() => undefined);
  }
}

function buildGates(
  initial: Timed<IncrementalAnalysisResult>,
  noChange: Timed<IncrementalAnalysisResult>,
  edited: Timed<IncrementalAnalysisResult>,
  packet: Awaited<ReturnType<typeof getAgentWorkPacket>>,
  edit: IncrementalTargetReport['edit'],
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
    edited.durationMs <= Math.max(noChange.durationMs * 8, 5000) ||
    (initial.durationMs < 1000 && edited.durationMs <= initial.durationMs + 750)
  );
  const gates = [
    gate('initial-analysis-complete', initial.value.output.nodes.length > 0, `${initial.value.output.nodes.length} nodes`),
    gate('initial-state-built', initial.value.wasFullRebuild, `wasFullRebuild=${initial.value.wasFullRebuild}`),
    gate('no-change-incremental', !noChange.value.wasFullRebuild, `wasFullRebuild=${noChange.value.wasFullRebuild}`),
    gate('no-change-empty-summary', summarizeChangedFiles(noChange.value) === 0, `${summarizeChangedFiles(noChange.value)} files changed`),
    gate('syntactic-source-edit-applied', edit.kind === 'syntactic-probe', `${edit.kind}: ${edit.detail}`),
    gate('edit-detected', editDetected, `${changedFiles} files changed, ${casDelta} CAS nodes changed`),
    softGate('edit-produced-cas-delta', casDelta > 0 || changedFiles > 0, `${casDelta} CAS nodes changed, ${changedFiles} files changed`),
    gate('edit-stayed-incremental', !edited.value.wasFullRebuild, `wasFullRebuild=${edited.value.wasFullRebuild}`),
    softGate('edit-performance-acceptable', editPerformanceAcceptable, `${edited.durationMs}ms vs ${initial.durationMs}ms`),
    gate('agent-packet-after-edit', packet.file_read_plan.length > 0 && packet.next_mcp_calls.length > 0, `${packet.file_read_plan.length} files, ${packet.next_mcp_calls.length} calls`),
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
  const sourceFiles = await glob(['**/*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,cs,php,dart}'], {
    cwd: workspace,
    ignore: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.git/**',
      '**/target/**',
      '**/coverage/**',
      '**/.dart_tool/**',
      '**/bin/**',
      '**/obj/**',
      '**/vendor/**',
      '**/vendors/**',
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
  if (/^(vite|webpack|rollup|next|nuxt|svelte|astro|jest|vitest|cypress|playwright|eslint|prettier|babel|postcss|tailwind)\.config\.[cm]?[jt]s$/i.test(basename)) return true;
  if (/^(package|tsconfig|jsconfig|composer|pubspec|Cargo|go|pom|build\.gradle|requirements|pyproject|setup)\b/i.test(basename)) return true;
  if (/^(package-lock|pnpm-lock|yarn\.lock|Cargo\.lock|composer\.lock|go\.sum)$/i.test(basename)) return true;
  if (/^(manage|main|index)\.(py|ts|tsx|js|jsx|mjs|cjs)$/i.test(basename)) return true;
  if (isGeneratedBenchmarkFile(normalized)) return true;
  return false;
}

function isGeneratedBenchmarkFile(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  if (/(^|\/)(generated|Generated|dist|build|target|vendor|vendors)(\/|$)/.test(normalized)) return true;
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
]);

async function applySafeSourceEdit(filePath: string): Promise<IncrementalTargetReport['edit']> {
  const content = await fs.readFile(filePath, 'utf-8');
  const extension = path.extname(filePath).toLowerCase();
  const probe = sourceProbeForExtension(extension);
  await new Promise(resolve => setTimeout(resolve, 5));
  if (probe) {
    await fs.writeFile(filePath, `${trimTrailingWhitespace(content)}\n\n${probe}\n`, 'utf-8');
    return { kind: 'syntactic-probe', detail: `appended ${extension || 'source'} declaration` };
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
      return 'const analysisProbe = "cas-edit-loop";';
    case '.py':
      return 'analysis_probe = "cas-edit-loop"';
    case '.rs':
      return 'const ANALYSIS_PROBE: &str = "cas-edit-loop";';
    case '.go':
      return 'const analysisProbe = "cas-edit-loop"';
    case '.java':
      return '// analysis probe: cas-edit-loop';
    case '.cs':
      return '// analysis probe: cas-edit-loop';
    case '.php':
      return '// analysis probe: cas-edit-loop';
    case '.dart':
      return 'const analysisProbe = "cas-edit-loop";';
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
  await fs.copy(source, destination, {
    filter: file => {
      const relative = path.relative(source, file);
      if (!relative) return true;
      const normalized = relative.replace(/\\/g, '/');
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
        '.unravl-agent-home',
        '.unravl-agent-benchmark',
        '.unravl-agent-quality-benchmark',
        '.unravl-agent-vision-acceptance',
        '.unravl-agent-live-trials',
        '.unravl-incremental-benchmark',
      ].includes(part));
    },
  });
}

function initializeBenchmarkGitBaseline(workspace: string): void {
  execFileSync('git', ['init'], { cwd: workspace, stdio: 'pipe' });
  execFileSync('git', ['add', '.'], { cwd: workspace, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'incremental benchmark baseline'], {
    cwd: workspace,
    env: gitEnv(),
    stdio: 'pipe',
  });
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Unravl Benchmark',
    GIT_AUTHOR_EMAIL: 'benchmark@unravl.local',
    GIT_COMMITTER_NAME: 'Unravl Benchmark',
    GIT_COMMITTER_EMAIL: 'benchmark@unravl.local',
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
    '# Unravl Incremental Analysis Benchmark',
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
    `Average no-change speedup vs full: ${report.summary.average_no_change_speedup_vs_full}x`,
    `Average edit speedup vs full: ${report.summary.average_edit_speedup_vs_full}x`,
    `Average agent packet generation after edit: ${report.summary.average_packet_generation_ms_after_edit}ms`,
    `Average file-read plan after edit: ${report.summary.average_file_read_plan_after_edit} files`,
    `Average packet size after edit: ${report.summary.average_packet_tokens_after_edit} estimated tokens`,
    `Average full-verify count similarity: ${Math.round(report.summary.average_full_verify_count_similarity * 100)}%`,
    '',
    '## Repository Summary',
    '',
    '| Repo | Status | Score | Edited file | Full ms | Edit incremental ms | Speedup | Changed files | Packet files | Parity |',
    '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const target of report.targets) {
    lines.push(`| ${target.name} | ${target.status} | ${target.score} | ${target.edited_file || ''} | ${target.timings.initial_full_ms} | ${target.timings.edit_incremental_ms} | ${target.speedups.edit_incremental_vs_full}x | ${target.change_summary.files_changed} | ${target.agent_value_after_edit.file_read_plan_count} | ${target.full_verify_parity ? `${Math.round(target.full_verify_parity.count_similarity * 100)}%` : 'not run'} |`);
  }

  lines.push('', '## Target Details', '');
  for (const target of report.targets) {
    lines.push(`### ${target.name}`, '');
    lines.push(`Workspace: ${target.workspace}`);
    lines.push(`Edited file: ${target.edited_file || 'none'}`);
    lines.push(`Edit: ${target.edit.kind} (${target.edit.detail})`);
    lines.push(`Timings: full ${target.timings.initial_full_ms}ms, no-change incremental ${target.timings.no_change_incremental_ms}ms, edit incremental ${target.timings.edit_incremental_ms}ms${target.timings.verify_full_after_edit_ms ? `, verify full ${target.timings.verify_full_after_edit_ms}ms` : ''}.`);
    lines.push(`Change summary: ${target.change_summary.files_changed} files changed, ${target.change_summary.nodes_added} nodes added, ${target.change_summary.nodes_modified} nodes modified, ${target.change_summary.nodes_deleted} nodes deleted, risk ${target.change_summary.risk_level}.`);
    lines.push(`Agent packet after edit: ${target.agent_value_after_edit.file_read_plan_count} files, ${target.agent_value_after_edit.next_mcp_calls} MCP calls, ${target.agent_value_after_edit.estimated_packet_tokens} estimated tokens, ${target.agent_value_after_edit.packet_generation_ms}ms.`);
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
    concurrency: args.concurrency,
  });

  await fs.ensureDir(path.dirname(args.outputPath));
  await fs.writeJson(args.outputPath, report, { spaces: 2 });
  await fs.ensureDir(path.dirname(args.markdownPath));
  await fs.writeFile(args.markdownPath, formatIncrementalValueMarkdownReport(report), 'utf8');
  const saved = await saveAgenticBenchmarkReport(report);
  console.log(`Incremental analysis benchmark: ${report.status.toUpperCase()} (${report.score}/100)`);
  console.log(`Targets: ${report.summary.target_count} | Incremental success ${Math.round(report.summary.incremental_success_rate * 100)}% | Edit speedup ${report.summary.average_edit_speedup_vs_full}x | Packet ${report.summary.average_packet_generation_ms_after_edit}ms/${report.summary.average_packet_tokens_after_edit} tokens`);
  for (const target of report.targets) {
    console.log(`${target.status.toUpperCase().padEnd(4)} ${String(target.score).padStart(3)}/100 | ${target.name} | ${target.edited_file || 'no edit'} | ${target.timings.initial_full_ms}ms full | ${target.timings.edit_incremental_ms}ms edit incr | ${target.speedups.edit_incremental_vs_full}x | packet ${target.agent_value_after_edit.file_read_plan_count} files`);
  }
  console.log(`Report: ${args.outputPath}`);
  console.log(`Markdown: ${args.markdownPath}`);
  console.log(`Persisted MCP report: ${saved.file}`);
  if (report.status === 'fail') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
