import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';
import { getOrchestrator } from './analyzer';
import { getAgentWorkPacket, type AgentTask } from './agent-adoption';
import { loadTruthExpectation, type AnalysisTruthExpectation } from './analysis-mastery';
import { discoverTargets } from './gauntlet';
import { saveAgenticBenchmarkReport } from './storage';
import type { CASEntryPoint, CASNode, CASOutput } from '../../backend/src/types/cas.types';

type GateStatus = 'pass' | 'warn' | 'fail';

interface BenchmarkTarget {
  name: string;
  path: string;
  expectation: AnalysisTruthExpectation;
}

interface SourceFileStat {
  file: string;
  bytes: number;
  estimated_tokens: number;
}

interface AgenticComparison {
  benchmark_type: 'deterministic-proxy';
  measurement_note: string;
  with_unravl: {
    packet_generation_ms: number;
    mcp_calls: number;
    files_to_read: number;
    source_tokens: number;
    packet_tokens: number;
    total_context_tokens: number;
    estimated_work_ms: number;
    estimated_cached_solution_ms: number;
    estimated_first_run_solution_ms: number;
  };
  without_unravl: {
    cold_scan_files: number;
    cold_scan_tokens: number;
    cold_scan_estimated_solution_ms: number;
    search_strategy_files: number;
    search_strategy_file_tokens: number;
    search_strategy_context_overhead_tokens: number;
    search_strategy_tokens: number;
    search_strategy_estimated_solution_ms: number;
    estimated_work_ms: number;
  };
  deltas: {
    cold_scan_token_reduction_percentage: number;
    search_strategy_token_reduction_percentage: number;
    cold_scan_file_reduction_percentage: number;
    search_strategy_file_reduction_percentage: number;
    estimated_speedup_vs_cold_scan: number;
    estimated_speedup_vs_search: number;
  };
  two_agent_protocol: {
    agent_without_unravl_prompt: string;
    agent_with_unravl_prompt: string;
    metrics_to_record: string[];
  };
}

interface BenchmarkTask {
  id: string;
  label: string;
  category: 'orient' | 'modify' | 'debug' | 'review' | 'trace' | 'runtime' | 'data' | 'external' | 'test';
  task: AgentTask;
  expected_outcome: string;
}

interface TaskSuccessReport {
  with_unravl: {
    success: boolean;
    status: GateStatus;
    score: number;
    gates: Array<{ id: string; status: GateStatus; score: number; detail: string }>;
  };
  without_unravl_proxy: {
    projected_success_probability: number;
    status: GateStatus;
    risk_factors: string[];
  };
  advantage: {
    success_probability_delta: number;
    token_reduction_vs_search_percentage: number;
    time_reduction_vs_search_percentage: number;
  };
}

interface TaskScore {
  task_id: string;
  task_label: string;
  task_category: BenchmarkTask['category'];
  expected_outcome: string;
  task: AgentTask;
  status: GateStatus;
  score: number;
  selected_node?: unknown;
  file_read_plan: unknown[];
  validation_plan: unknown;
  baseline: {
    cold_repo_files: number;
    planned_files: number;
    file_reduction_percentage: number;
  };
  agentic_comparison: AgenticComparison;
  solution: TaskSuccessReport;
  gates: Array<{ id: string; status: GateStatus; score: number; detail: string }>;
}

function parseArgs(argv: string[]) {
  const repos: BenchmarkTarget[] = [];
  let fixtureRoot = path.join(process.cwd(), 'fixtures', 'analysis-truth');
  let outputPath = path.join(process.cwd(), '.unravl-agent-benchmark', 'latest-report.json');
  let markdownPath = path.join(process.cwd(), '.unravl-agent-benchmark', 'latest-report.md');
  let includeFixtures = true;
  let task: AgentTask | undefined;
  let suite = false;
  let includeRealRepos = false;
  let devRoot = path.join(process.env.HOME || '', 'dev');
  let maxTargets: number | undefined;
  let maxTasksPerRepo = 8;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') {
      const value = argv[++i];
      if (!value) throw new Error('--repo requires a path or name=path value');
      const [namePart, repoPathPart] = value.includes('=') ? value.split('=') : [undefined, value];
      const repoPath = path.resolve(repoPathPart);
      repos.push({ name: namePart || path.basename(repoPath), path: repoPath, expectation: {} });
    } else if (arg === '--fixture-root') {
      fixtureRoot = path.resolve(argv[++i]);
    } else if (arg === '--output') {
      outputPath = path.resolve(argv[++i]);
    } else if (arg === '--markdown') {
      markdownPath = path.resolve(argv[++i]);
    } else if (arg === '--task-type') {
      task = { ...(task || {}), task_type: argv[++i] as any };
    } else if (arg === '--target') {
      task = { ...(task || {}), target: argv[++i] };
    } else if (arg === '--instructions') {
      task = { ...(task || {}), instructions: argv[++i] };
    } else if (arg === '--success-criterion') {
      task = { ...(task || {}), success_criteria: [...(task?.success_criteria || []), argv[++i]] };
    } else if (arg === '--suite') {
      suite = true;
    } else if (arg === '--real-repos') {
      includeRealRepos = true;
    } else if (arg === '--dev-root') {
      devRoot = path.resolve(argv[++i]);
    } else if (arg === '--max-targets') {
      maxTargets = Number(argv[++i]);
    } else if (arg === '--max-tasks-per-repo') {
      maxTasksPerRepo = Number(argv[++i]);
    } else if (arg === '--no-fixtures') {
      includeFixtures = false;
    } else if (arg === '--agentic') {
      continue;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { repos, fixtureRoot, outputPath, markdownPath, includeFixtures, task, suite, includeRealRepos, devRoot, maxTargets, maxTasksPerRepo };
}

function printHelp(): void {
  console.log([
    'Usage: npm run agent-benchmark -- [options]',
    '',
    'Options:',
    '  --repo name=/path/to/repo   Run a specific repo. May be repeated.',
    '  --task-type type           orient|modify|debug|review|trace|cross-repo|runtime.',
    '  --target query             Target for a two-agent comparison task.',
    '  --instructions text        Specific task instructions for requested-task and live runs.',
    '  --success-criterion text   Success criterion for requested-task and live runs. May be repeated.',
    '  --suite                    Generate several CAS-derived tasks per repo.',
    '  --real-repos               Include discovered repos under --dev-root.',
    '  --dev-root /path           Root used for real repo discovery.',
    '  --max-targets n            Limit total targets.',
    '  --max-tasks-per-repo n     Limit generated suite tasks per repo.',
    '  --fixture-root /path       Built-in analysis-truth fixture root.',
    '  --output /path/report.json Write JSON report.',
    '  --markdown /path/report.md Write Markdown report.',
    '  --no-fixtures              Skip built-in fixtures.',
  ].join('\n'));
}

async function fixtureTargets(fixtureRoot: string): Promise<BenchmarkTarget[]> {
  const entries = await fs.readdir(fixtureRoot, { withFileTypes: true });
  const targets: BenchmarkTarget[] = [];

  for (const entry of entries.filter(candidate => candidate.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    const projectPath = path.join(fixtureRoot, entry.name);
    const expectation = await loadTruthExpectation(projectPath);
    if (!expectation) continue;
    targets.push({ name: expectation.name || entry.name, path: projectPath, expectation });
  }

  return targets;
}

async function sourceFileStats(projectPath: string): Promise<SourceFileStat[]> {
  const files = await glob([
    '**/*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,cs,php,dart,prisma}',
    '**/{package.json,tsconfig.json,jsconfig.json,pyproject.toml,requirements.txt,go.mod,Cargo.toml,composer.json,pubspec.yaml,*.csproj,*.sln,README.md,readme.md}',
  ], {
    cwd: projectPath,
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
  const stats: SourceFileStat[] = [];
  for (const file of files.sort()) {
    const absolutePath = path.join(projectPath, file);
    const stat = await fs.stat(absolutePath);
    stats.push({
      file,
      bytes: stat.size,
      estimated_tokens: estimateTokens(stat.size),
    });
  }
  return stats;
}

async function sourceFileCount(projectPath: string): Promise<number> {
  return (await sourceFileStats(projectPath)).length;
}

function tasksForExpectation(expectation: AnalysisTruthExpectation): BenchmarkTask[] {
  const targets = [
    ...(expectation.nodes || []).slice(0, 3).map(node => node.name),
    ...(expectation.routes || []).slice(0, 2).map(route => route.handler || route.path),
  ].filter(Boolean) as string[];

  const uniqueTargets = [...new Set(targets)].slice(0, 4);
  const tasks: BenchmarkTask[] = uniqueTargets.map((target, index) => taskCard(`truth-modify-${index + 1}`, `Modify ${target}`, 'modify', { task_type: 'modify', target }, 'Resolve the target and produce a focused edit context.'));
  if (tasks.length === 0) tasks.push(taskCard('orient', 'Orient on the codebase', 'orient', { task_type: 'orient' }, 'Explain the codebase from CAS-backed context.'));
  tasks.push(taskCard('truth-debug', `Debug ${uniqueTargets[0] || 'representative target'}`, 'debug', { task_type: 'debug', target: uniqueTargets[0] }, 'Resolve the debug target, error context, and first files.'));
  return tasks;
}

function taskSuiteForCas(cas: CASOutput, expectation: AnalysisTruthExpectation, maxTasks: number): BenchmarkTask[] {
  const tasks = new Map<string, BenchmarkTask>();
  const add = (task: BenchmarkTask) => {
    if (tasks.size < maxTasks && !tasks.has(task.id)) tasks.set(task.id, task);
  };

  add(taskCard('orient-system', 'Orient on the system', 'orient', { task_type: 'orient' }, 'Explain system purpose, shape, entry points, risks, and next tool calls.'));

  for (const task of tasksForExpectation(expectation)) add(task);

  const connected = mostConnectedNodes(cas).slice(0, 3);
  for (const node of connected) {
    add(taskCard(`modify-${slugify(node.id)}`, `Modify ${node.name}`, 'modify', { task_type: 'modify', target: node.name }, 'Resolve impact, callers, callees, tests, and first source files.'));
  }

  const entry = (cas.entry_points || []).find(candidate => candidate.handler?.method_name || candidate.name);
  if (entry) {
    add(taskCard(`trace-${slugify(entry.id)}`, `Trace ${entry.name}`, 'trace', { task_type: 'trace', target: entry.handler?.method_name || entry.name }, 'Trace from entry point to implementation and external boundaries.'));
  }

  const exitPoint = (cas.exit_points || []).find(candidate => candidate.type === 'api' || candidate.type === 'database' || candidate.type === 'message' || candidate.type === 'sdk') || (cas.exit_points || [])[0];
  if (exitPoint) {
    const target = exitTaskTarget(cas, exitPoint);
    add(taskCard(`external-${slugify(exitPoint.id)}`, `Explain external boundary ${target}`, 'external', { task_type: 'debug', target }, 'Resolve the external dependency, owning code, and failure surface.'));
  }

  const authTarget = authTaskTarget(cas);
  if (authTarget) {
    add(taskCard('auth-review', `Review ${authTarget}`, 'review', { task_type: 'review', target: authTarget }, 'Resolve authentication or authorization code and its safety context.'));
  }

  const dataTarget = dataTaskTarget(cas);
  if (dataTarget) {
    add(taskCard('data-flow', `Trace data flow for ${dataTarget}`, 'data', { task_type: 'trace', target: dataTarget }, 'Resolve data ownership, lifecycle, and query paths.'));
  }

  const runtimeTarget = (cas.runtime_static_links || [])[0];
  if (runtimeTarget) {
    add(taskCard(`runtime-${slugify(runtimeTarget.static_id || runtimeTarget.runtime_signal)}`, `Correlate runtime signal ${runtimeTarget.runtime_signal}`, 'runtime', { task_type: 'runtime', target: runtimeTarget.static_id || runtimeTarget.runtime_signal }, 'Map runtime signal to the static graph and instrumentation points.'));
  }

  const testSuite = (cas.test_suites || [])[0] as any;
  const testNode = (cas.nodes || []).find(node => node.metadata?.is_test);
  const testTarget = testSuite?.name || testSuite?.id || testNode?.name;
  if (testTarget) {
    add(taskCard(`test-${slugify(testTarget)}`, `Find tests for ${testTarget}`, 'test', { task_type: 'review', target: String(testTarget) }, 'Resolve test evidence and related implementation.'));
  }

  return Array.from(tasks.values()).slice(0, maxTasks);
}

function taskCard(id: string, label: string, category: BenchmarkTask['category'], task: AgentTask, expectedOutcome: string): BenchmarkTask {
  return { id, label, category, task, expected_outcome: expectedOutcome };
}

async function scoreTask(cas: CASOutput, projectPath: string, benchmarkTask: BenchmarkTask, sourceFiles: SourceFileStat[], analysisDurationMs: number, taskCount: number): Promise<TaskScore> {
  const task = benchmarkTask.task;
  const packetStartedAt = Date.now();
  const packet = await getAgentWorkPacket(cas, projectPath, task);
  const packetGenerationMs = Math.max(1, Date.now() - packetStartedAt);
  const filesInRepo = sourceFiles.length;
  const planFiles = packet.file_read_plan.map(item => String(item.file)).filter(Boolean);
  const selectedFile = packet.selected_node?.file ? String(packet.selected_node.file) : undefined;
  const reduction = filesInRepo === 0 ? 0 : Math.max(0, Math.round(((filesInRepo - planFiles.length) / filesInRepo) * 100));
  const gates = [
    gate('target-resolved', Boolean(packet.selected_node) || task.task_type === 'orient', packet.selected_node?.name || 'not resolved'),
    gate('file-plan-present', planFiles.length > 0, `${planFiles.length} files`),
    gate('file-plan-narrower-than-repo', filesInRepo <= 1 || planFiles.length < filesInRepo, `${planFiles.length}/${filesInRepo}`),
    gate('selected-file-included', !selectedFile || planFiles.some(file => pathsCompatible(file, selectedFile)), selectedFile || 'no selected file'),
    gate('mcp-followups-present', packet.next_mcp_calls.length > 0, `${packet.next_mcp_calls.length} calls`),
    gate('coding-context-present', task.task_type === 'orient' || Boolean(packet.work_context.coding_context), packet.work_context.coding_context ? 'coding context' : 'no coding context'),
    gate('risk-context-present', task.task_type === 'orient' || Boolean(packet.work_context.risk), packet.work_context.risk ? 'risk context' : 'no risk context'),
    gate('beats-cold-repo-read', beatsColdRepoRead(filesInRepo, planFiles.length, reduction), `${reduction}% fewer files`),
  ];
  const score = Math.round(gates.reduce((sum, result) => sum + result.score, 0) / gates.length);
  const comparison = buildAgenticComparison(projectPath, task, packet, sourceFiles, packetGenerationMs, Math.round(analysisDurationMs / Math.max(1, taskCount)));

  return {
    task_id: benchmarkTask.id,
    task_label: benchmarkTask.label,
    task_category: benchmarkTask.category,
    expected_outcome: benchmarkTask.expected_outcome,
    task,
    status: statusFromScore(score),
    score,
    selected_node: packet.selected_node,
    file_read_plan: packet.file_read_plan,
    validation_plan: packet.validation_plan,
    baseline: {
      cold_repo_files: filesInRepo,
      planned_files: planFiles.length,
      file_reduction_percentage: reduction,
    },
    agentic_comparison: comparison,
    solution: buildSuccessReport(gates, score, comparison, task),
    gates,
  };
}

function gate(id: string, passed: boolean, detail: string) {
  return {
    id,
    status: passed ? 'pass' as GateStatus : 'fail' as GateStatus,
    score: passed ? 100 : 0,
    detail,
  };
}

function beatsColdRepoRead(filesInRepo: number, plannedFiles: number, reduction: number): boolean {
  if (filesInRepo <= 1) return true;
  if (filesInRepo <= 3) return plannedFiles <= 1;
  if (filesInRepo <= 8) return plannedFiles <= 3;
  return reduction >= 70;
}

function buildAgenticComparison(
  projectPath: string,
  task: AgentTask,
  packet: Awaited<ReturnType<typeof getAgentWorkPacket>>,
  sourceFiles: SourceFileStat[],
  packetGenerationMs: number,
  amortizedAnalysisMs = 0
): AgenticComparison {
  const planFiles = packet.file_read_plan.map(item => String(item.file)).filter(Boolean);
  const planItems = packet.file_read_plan as Array<{ file?: string; line_window?: { start?: number; end?: number } }>;
  const packetTokens = estimateTokens(JSON.stringify(packet).length);
  const withSourceTokens = estimatePlannedSourceTokens(projectPath, planItems, sourceFiles);
  const withTotalTokens = withSourceTokens + packetTokens;
  const coldScanTokens = sum(sourceFiles.map(file => file.estimated_tokens));
  const searchStats = sourceSearchBaseline(sourceFiles, task);
  const searchFileTokens = sum(searchStats.map(file => file.estimated_tokens));
  const searchOverheadTokens = estimateSearchOverheadTokens(sourceFiles.length, searchStats.length, task);
  const searchTokens = searchFileTokens + searchOverheadTokens;
  const withEstimatedMs = estimateAgentWorkMs(planFiles.length, withTotalTokens, packetGenerationMs);
  const coldEstimatedMs = estimateAgentWorkMs(sourceFiles.length, coldScanTokens, 0);
  const searchEstimatedMs = estimateAgentWorkMs(searchStats.length, searchTokens, 0);
  const withFirstRunMs = withEstimatedMs + amortizedAnalysisMs;

  return {
    benchmark_type: 'deterministic-proxy',
    measurement_note: 'Token counts are local estimates from file bytes and MCP packet size. Speed is a deterministic work estimate plus measured Unravl packet generation; provider-reported tokens should be captured with the included two-agent protocol.',
    with_unravl: {
      packet_generation_ms: packetGenerationMs,
      mcp_calls: packet.next_mcp_calls.length,
      files_to_read: planFiles.length,
      source_tokens: withSourceTokens,
      packet_tokens: packetTokens,
      total_context_tokens: withTotalTokens,
      estimated_work_ms: withEstimatedMs,
      estimated_cached_solution_ms: withEstimatedMs,
      estimated_first_run_solution_ms: withFirstRunMs,
    },
    without_unravl: {
      cold_scan_files: sourceFiles.length,
      cold_scan_tokens: coldScanTokens,
      cold_scan_estimated_solution_ms: coldEstimatedMs,
      search_strategy_files: searchStats.length,
      search_strategy_file_tokens: searchFileTokens,
      search_strategy_context_overhead_tokens: searchOverheadTokens,
      search_strategy_tokens: searchTokens,
      search_strategy_estimated_solution_ms: searchEstimatedMs,
      estimated_work_ms: searchEstimatedMs,
    },
    deltas: {
      cold_scan_token_reduction_percentage: percentReduction(coldScanTokens, withTotalTokens),
      search_strategy_token_reduction_percentage: percentReduction(searchTokens, withTotalTokens),
      cold_scan_file_reduction_percentage: percentReduction(sourceFiles.length, planFiles.length),
      search_strategy_file_reduction_percentage: percentReduction(searchStats.length, planFiles.length),
      estimated_speedup_vs_cold_scan: ratio(coldEstimatedMs, withEstimatedMs),
      estimated_speedup_vs_search: ratio(searchEstimatedMs, withEstimatedMs),
    },
    two_agent_protocol: {
      agent_without_unravl_prompt: agentPromptWithoutUnravl(projectPath, task),
      agent_with_unravl_prompt: agentPromptWithUnravl(projectPath, task),
      metrics_to_record: [
        'wall_clock_seconds',
        'provider_input_tokens',
        'provider_output_tokens',
        'tool_calls',
        'source_files_read',
        'source_files_edited',
        'tests_run',
        'test_result',
        'task_success',
        'human_interventions',
      ],
    },
  };
}

function buildSuccessReport(
  gates: Array<{ id: string; status: GateStatus; score: number; detail: string }>,
  score: number,
  comparison: AgenticComparison,
  task: AgentTask
): TaskSuccessReport {
  const riskFactors = baselineRiskFactors(comparison, task);
  const projectedProbability = projectedBaselineSuccess(comparison, riskFactors);
  const withStatus = statusFromScore(score);
  return {
    with_unravl: {
      success: score >= 90,
      status: withStatus,
      score,
      gates,
    },
    without_unravl_proxy: {
      projected_success_probability: projectedProbability,
      status: projectedProbability >= 0.85 ? 'pass' : projectedProbability >= 0.6 ? 'warn' : 'fail',
      risk_factors: riskFactors,
    },
    advantage: {
      success_probability_delta: Number((Math.max(0, score / 100 - projectedProbability)).toFixed(2)),
      token_reduction_vs_search_percentage: comparison.deltas.search_strategy_token_reduction_percentage,
      time_reduction_vs_search_percentage: percentReduction(
        comparison.without_unravl.search_strategy_estimated_solution_ms,
        comparison.with_unravl.estimated_cached_solution_ms
      ),
    },
  };
}

function baselineRiskFactors(comparison: AgenticComparison, task: AgentTask): string[] {
  const risks: string[] = [];
  if (comparison.without_unravl.search_strategy_files > 40) risks.push('search baseline leaves more than 40 candidate files');
  if (comparison.without_unravl.search_strategy_tokens > 120000) risks.push('search baseline exceeds a practical one-pass context budget');
  if (!task.target) risks.push('task target is broad or implicit');
  if (comparison.deltas.search_strategy_file_reduction_percentage < 25) risks.push('Unravl and search file counts are close for this task');
  if (comparison.deltas.search_strategy_token_reduction_percentage < 25) risks.push('Unravl and search token counts are close for this task');
  return risks;
}

function projectedBaselineSuccess(comparison: AgenticComparison, riskFactors: string[]): number {
  let probability = 0.92;
  if (comparison.without_unravl.search_strategy_files > 10) probability -= 0.08;
  if (comparison.without_unravl.search_strategy_files > 40) probability -= 0.18;
  if (comparison.without_unravl.search_strategy_tokens > 64000) probability -= 0.12;
  if (comparison.without_unravl.search_strategy_tokens > 200000) probability -= 0.18;
  probability -= Math.min(0.2, riskFactors.length * 0.04);
  return Number(Math.max(0.15, Math.min(0.98, probability)).toFixed(2));
}

function sourceSearchBaseline(sourceFiles: SourceFileStat[], task: AgentTask): SourceFileStat[] {
  const target = (task.target || '').toLowerCase();
  const configCandidates = sourceFiles.filter(file => /(^|\/)(package\.json|tsconfig|pyproject|go\.mod|cargo\.toml|pom\.xml|build\.gradle|readme)/i.test(file.file));
  if (!target) return sourceFiles;

  const targetTokens = target.split(/[^a-z0-9]+/).filter(token => token.length > 2);
  const candidates = sourceFiles.filter(file => {
    const lower = file.file.toLowerCase();
    return targetTokens.some(token => lower.includes(token));
  });
  const selected = [...configCandidates, ...candidates].filter((file, index, values) => values.findIndex(candidate => candidate.file === file.file) === index);
  return selected.length > 0 ? selected : sourceFiles;
}

function findSourceStat(sourceFiles: SourceFileStat[], file: string): SourceFileStat | undefined {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  return sourceFiles.find(candidate => pathsCompatible(candidate.file, normalized));
}

function estimateTokens(size: number): number {
  return Math.max(1, Math.ceil(size / 4));
}

function estimatePlannedSourceTokens(
  projectPath: string,
  planItems: Array<{ file?: string; line_window?: { start?: number; end?: number } }>,
  sourceFiles: SourceFileStat[]
): number {
  return sum(planItems.map(item => {
    const file = item.file ? String(item.file) : '';
    const stat = findSourceStat(sourceFiles, file);
    if (!stat) return 0;
    const window = item.line_window;
    if (!window?.start || !window?.end || window.end < window.start) return stat.estimated_tokens;
    try {
      const absolutePath = path.resolve(projectPath, file);
      const lines = fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/);
      const startIndex = Math.max(0, Math.floor(window.start) - 1);
      const endIndex = Math.min(lines.length, Math.floor(window.end));
      if (startIndex >= endIndex) return stat.estimated_tokens;
      const sliceTokens = estimateTokens(lines.slice(startIndex, endIndex).join('\n').length);
      return Math.min(stat.estimated_tokens, Math.max(1, sliceTokens));
    } catch {
      return stat.estimated_tokens;
    }
  }));
}

function estimateAgentWorkMs(files: number, tokens: number, baseMs: number): number {
  return Math.max(1, Math.round(baseMs + files * 40 + tokens * 0.35));
}

function estimateSearchOverheadTokens(sourceFileCount: number, matchedFileCount: number, task: AgentTask): number {
  const repoSearchOutput = Math.min(50000, Math.max(2000, sourceFileCount * 120));
  const fileReviewOverhead = matchedFileCount * 600;
  const taskOverhead = task.target ? 1000 : 4000;
  return repoSearchOutput + fileReviewOverhead + taskOverhead;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentReduction(baseline: number, actual: number): number {
  if (baseline <= 0) return actual <= 0 ? 100 : 0;
  return Math.round(((baseline - actual) / baseline) * 100);
}

function ratio(baseline: number, actual: number): number {
  if (actual <= 0) return baseline > 0 ? baseline : 1;
  return Number((baseline / actual).toFixed(2));
}

function agentPromptWithoutUnravl(projectPath: string, task: AgentTask): string {
  return [
    `You are working in ${projectPath}.`,
    `Task: ${task.task_type || 'orient'}${task.target ? ` ${task.target}` : ''}.`,
    task.instructions ? `Instructions: ${task.instructions}` : '',
    task.success_criteria?.length ? `Success criteria: ${task.success_criteria.join('; ')}` : '',
    'Do not use Unravl, its MCP server, or any precomputed CAS output.',
    'Use normal repository exploration and complete the task. Record wall time, input tokens, output tokens, files read, tool calls, edits, tests, and result.',
  ].join('\n');
}

function agentPromptWithUnravl(projectPath: string, task: AgentTask): string {
  return [
    `You are working in ${projectPath}.`,
    `Task: ${task.task_type || 'orient'}${task.target ? ` ${task.target}` : ''}.`,
    task.instructions ? `Instructions: ${task.instructions}` : '',
    task.success_criteria?.length ? `Success criteria: ${task.success_criteria.join('; ')}` : '',
    'Use Unravl by default before broad file reads.',
    `First call get_agent_doctor with path ${JSON.stringify(projectPath)}.`,
    `Then call get_agent_start_context and get_agent_work_packet with path ${JSON.stringify(projectPath)} and task ${JSON.stringify(task)}.`,
    'Read source files after the work packet narrows the target or when MCP reports a concrete gap. Record wall time, input tokens, output tokens, files read, tool calls, edits, tests, and result.',
  ].join('\n');
}

function mostConnectedNodes(cas: CASOutput): CASNode[] {
  const counts = new Map<string, number>();
  for (const edge of cas.edges || []) {
    counts.set(edge.source, (counts.get(edge.source) || 0) + 1);
    counts.set(edge.target, (counts.get(edge.target) || 0) + 1);
  }
  for (const call of cas.method_calls || []) {
    counts.set(call.caller_node, (counts.get(call.caller_node) || 0) + 1);
    if (call.target_node) counts.set(call.target_node, (counts.get(call.target_node) || 0) + 1);
  }
  return [...(cas.nodes || [])]
    .filter(node => isGoodBenchmarkNode(node))
    .sort((left, right) => (counts.get(right.id) || 0) - (counts.get(left.id) || 0));
}

function isGoodBenchmarkNode(node: CASNode): boolean {
  if (!node.source?.file || node.metadata?.is_generated) return false;
  const type = node.type.toLowerCase();
  const name = node.name.toLowerCase();
  if (type.includes('call') || type === 'import' || type === 'export' || type === 'variable' || type === 'file' || type === 'test') return false;
  if (isSyntheticCallsiteNode(node)) return false;
  if (name.startsWith('call to ') || name.startsWith('import ')) return false;
  return true;
}

function isSyntheticCallsiteNode(node: CASNode): boolean {
  return node.id.startsWith('callee_') ||
    node.subcategories?.includes('callee') === true ||
    node.description?.toLowerCase().startsWith('called by handler') === true;
}

function exitTaskTarget(cas: CASOutput, exitPoint: { name: string; source_node: string; target?: { resource?: string; endpoint?: string; sdk?: string; service_id?: string } }): string {
  const sourceNode = cas.nodes.find(node => node.id === exitPoint.source_node);
  if (sourceNode && isGoodBenchmarkNode(sourceNode)) return sourceNode.name;
  if (exitPoint.target?.resource) return exitPoint.target.resource;
  if (exitPoint.target?.service_id) return exitPoint.target.service_id;
  if (exitPoint.target?.sdk) return exitPoint.target.sdk;
  if (exitPoint.target?.endpoint) return exitPoint.target.endpoint;
  return exitPoint.name.replace(/^Call to\s+/i, '');
}

function authTaskTarget(cas: CASOutput): string | undefined {
  const entry = (cas.entry_points || []).find(candidate => targetText(candidate).includes('auth'));
  if (entry) return entry.handler?.method_name || entry.name;
  const node = (cas.nodes || []).find(candidate => targetText(candidate).includes('auth') || targetText(candidate).includes('login') || targetText(candidate).includes('jwt'));
  return node?.name;
}

function dataTaskTarget(cas: CASOutput): string | undefined {
  const entity = (cas.data_entities || [])[0] || (cas.database_schema?.entities || [])[0];
  if (entity?.name) return entity.name;
  const exitPoint = (cas.exit_points || []).find(candidate => candidate.type === 'database');
  return exitPoint?.target?.resource || exitPoint?.name;
}

function targetText(value: CASNode | CASEntryPoint): string {
  if ('handler' in value || 'trigger' in value) {
    const entry = value as CASEntryPoint;
    return [entry.name, entry.type, entry.trigger?.path, entry.trigger?.event, entry.handler?.method_name].filter(Boolean).join(' ').toLowerCase();
  }
  const node = value as CASNode;
  return [node.name, node.qualified_name, node.type, node.source?.file, ...(node.tags || [])].filter(Boolean).join(' ').toLowerCase();
}

function pathsCompatible(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/\\/g, '/');
  const normalizedRight = right.replace(/\\/g, '/');
  return normalizedLeft === normalizedRight || normalizedLeft.endsWith(`/${normalizedRight}`) || normalizedRight.endsWith(`/${normalizedLeft}`);
}

function slugify(input: string | undefined): string {
  return String(input || 'target')
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 80) || 'target';
}

function statusFromScore(score: number): GateStatus {
  if (score >= 90) return 'pass';
  if (score >= 70) return 'warn';
  return 'fail';
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

async function analyzeTarget(target: BenchmarkTarget, options: { requestedTask?: AgentTask; suite?: boolean; maxTasksPerRepo?: number } = {}) {
  const startedAt = Date.now();
  const cas = await getOrchestrator().orchestrateAnalysis(target.path);
  const analysisDurationMs = Date.now() - startedAt;
  const sourceFiles = await sourceFileStats(target.path);
  const tasks = options.requestedTask
    ? [taskCard('requested-task', `${options.requestedTask.task_type || 'orient'} ${options.requestedTask.target || ''}`.trim(), categoryForTask(options.requestedTask), options.requestedTask, options.requestedTask.instructions || 'Complete the user-provided benchmark task.')]
    : options.suite
      ? taskSuiteForCas(cas, target.expectation, options.maxTasksPerRepo || 8)
      : tasksForExpectation(target.expectation);
  const taskScores = await Promise.all(tasks.map(task => scoreTask(cas, target.path, task, sourceFiles, analysisDurationMs, tasks.length)));
  const score = Math.round(average(taskScores.map(task => task.score)));
  const averageReduction = Math.round(average(taskScores.map(task => task.baseline.file_reduction_percentage)));
  const withSuccessRate = average(taskScores.map(task => task.solution.with_unravl.success ? 100 : 0));
  const baselineSuccessRate = average(taskScores.map(task => task.solution.without_unravl_proxy.projected_success_probability * 100));
  return {
    name: target.name,
    path: target.path,
    status: aggregateStatus(taskScores.map(task => task.status)),
    score,
    durationMs: Date.now() - startedAt,
    analysis_duration_ms: analysisDurationMs,
    source_files: sourceFiles.length,
    source_tokens: sum(sourceFiles.map(file => file.estimated_tokens)),
    adoption_delta: {
      average_file_reduction_percentage: averageReduction,
      average_token_reduction_percentage_vs_cold_scan: Math.round(average(taskScores.map(task => task.agentic_comparison.deltas.cold_scan_token_reduction_percentage))),
      average_token_reduction_percentage_vs_search: Math.round(average(taskScores.map(task => task.agentic_comparison.deltas.search_strategy_token_reduction_percentage))),
      average_estimated_speedup_vs_cold_scan: Number(average(taskScores.map(task => task.agentic_comparison.deltas.estimated_speedup_vs_cold_scan)).toFixed(2)),
      average_estimated_speedup_vs_search: Number(average(taskScores.map(task => task.agentic_comparison.deltas.estimated_speedup_vs_search)).toFixed(2)),
      average_cached_solution_ms_with_unravl: Math.round(average(taskScores.map(task => task.agentic_comparison.with_unravl.estimated_cached_solution_ms))),
      average_first_run_solution_ms_with_unravl: Math.round(average(taskScores.map(task => task.agentic_comparison.with_unravl.estimated_first_run_solution_ms))),
      average_search_solution_ms_without_unravl: Math.round(average(taskScores.map(task => task.agentic_comparison.without_unravl.search_strategy_estimated_solution_ms))),
      with_unravl_success_rate: Number((withSuccessRate / 100).toFixed(2)),
      projected_without_unravl_success_rate: Number((baselineSuccessRate / 100).toFixed(2)),
      cold_repo_files_per_task: sourceFiles.length,
      planned_files_per_task: Math.round(average(taskScores.map(task => task.baseline.planned_files))),
    },
    tasks: taskScores,
  };
}

function categoryForTask(task: AgentTask): BenchmarkTask['category'] {
  if (task.task_type === 'debug') return 'debug';
  if (task.task_type === 'review') return 'review';
  if (task.task_type === 'trace') return 'trace';
  if (task.task_type === 'runtime') return 'runtime';
  if (task.task_type === 'modify') return 'modify';
  return 'orient';
}

export async function runAgenticBenchmark(options: {
  repos: Array<{ name?: string; path: string; expectation?: AnalysisTruthExpectation }>;
  includeFixtures?: boolean;
  fixtureRoot?: string;
  task?: AgentTask;
  suite?: boolean;
  includeRealRepos?: boolean;
  devRoot?: string;
  maxTargets?: number;
  maxTasksPerRepo?: number;
  quiet?: boolean;
}): Promise<{
  generatedAt: string;
  generated_at: string;
  status: GateStatus;
  score: number;
  benchmark_type: string;
  summary: {
    target_count: number;
    task_count: number;
    with_unravl_success_rate: number;
    projected_without_unravl_success_rate: number;
    average_token_reduction_vs_cold_scan: number;
    average_token_reduction_vs_search: number;
    average_file_reduction: number;
    average_speedup_vs_cold_scan: number;
    average_speedup_vs_search: number;
    average_cached_solution_ms_with_unravl: number;
    average_first_run_solution_ms_with_unravl: number;
    average_search_solution_ms_without_unravl: number;
  };
  targets: Awaited<ReturnType<typeof analyzeTarget>>[];
}> {
  const fixtureRoot = options.fixtureRoot || path.join(process.cwd(), 'fixtures', 'analysis-truth');
  const realRepos = options.includeRealRepos
    ? (await discoverTargets(options.devRoot || path.join(process.env.HOME || '', 'dev'))).map(target => ({
        name: target.name,
        path: target.path,
        expectation: {},
      }))
    : [];
  const selectedTargets = [
    ...(options.includeFixtures === false ? [] : await fixtureTargets(fixtureRoot)),
    ...realRepos,
    ...options.repos.map(repo => ({
      name: repo.name || path.basename(repo.path),
      path: path.resolve(repo.path),
      expectation: repo.expectation || {},
    })),
  ];
  const seen = new Set<string>();
  const targets = selectedTargets
    .filter(target => {
      const resolved = path.resolve(target.path);
      if (seen.has(resolved)) return false;
      seen.add(resolved);
      return true;
    })
    .slice(0, options.maxTargets || selectedTargets.length);
  if (targets.length === 0) throw new Error('No agent benchmark targets configured');

  const reports = [];
  for (const target of targets) {
    if (!options.quiet) console.log(`Benchmarking ${target.name}: ${target.path}`);
    reports.push(await withQuietLogs(Boolean(options.quiet), () => analyzeTarget(target, {
      requestedTask: options.task,
      suite: options.suite,
      maxTasksPerRepo: options.maxTasksPerRepo,
    })));
  }

  const generatedAt = new Date().toISOString();
  const allTasks = reports.flatMap(report => report.tasks);
  return {
    generatedAt,
    generated_at: generatedAt,
    status: aggregateStatus(reports.map(target => target.status)),
    score: Math.round(average(reports.map(target => target.score))),
    benchmark_type: options.suite ? 'agentic-suite-with-unravl-vs-without-unravl' : 'agentic-with-unravl-vs-without-unravl',
    summary: {
      target_count: reports.length,
      task_count: allTasks.length,
      with_unravl_success_rate: Number((average(allTasks.map(task => task.solution.with_unravl.success ? 100 : 0)) / 100).toFixed(2)),
      projected_without_unravl_success_rate: Number((average(allTasks.map(task => task.solution.without_unravl_proxy.projected_success_probability * 100)) / 100).toFixed(2)),
      average_token_reduction_vs_cold_scan: Math.round(average(allTasks.map(task => task.agentic_comparison.deltas.cold_scan_token_reduction_percentage))),
      average_token_reduction_vs_search: Math.round(average(allTasks.map(task => task.agentic_comparison.deltas.search_strategy_token_reduction_percentage))),
      average_file_reduction: Math.round(average(allTasks.map(task => task.baseline.file_reduction_percentage))),
      average_speedup_vs_cold_scan: Number(average(allTasks.map(task => task.agentic_comparison.deltas.estimated_speedup_vs_cold_scan)).toFixed(2)),
      average_speedup_vs_search: Number(average(allTasks.map(task => task.agentic_comparison.deltas.estimated_speedup_vs_search)).toFixed(2)),
      average_cached_solution_ms_with_unravl: Math.round(average(allTasks.map(task => task.agentic_comparison.with_unravl.estimated_cached_solution_ms))),
      average_first_run_solution_ms_with_unravl: Math.round(average(allTasks.map(task => task.agentic_comparison.with_unravl.estimated_first_run_solution_ms))),
      average_search_solution_ms_without_unravl: Math.round(average(allTasks.map(task => task.agentic_comparison.without_unravl.search_strategy_estimated_solution_ms))),
    },
    targets: reports,
  };
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

export function formatMarkdownReport(report: Awaited<ReturnType<typeof runAgenticBenchmark>>): string {
  const lines = [
    '# Unravl Agentic Benchmark Report',
    '',
    `Generated: ${report.generated_at}`,
    `Status: ${report.status}`,
    `Score: ${report.score}/100`,
    `Benchmark type: ${report.benchmark_type}`,
    '',
    '## Executive Summary',
    '',
    `Targets: ${report.summary.target_count}`,
    `Tasks: ${report.summary.task_count}`,
    `With Unravl success rate: ${Math.round(report.summary.with_unravl_success_rate * 100)}%`,
    `Projected without-Unravl success rate: ${Math.round(report.summary.projected_without_unravl_success_rate * 100)}%`,
    `Average token reduction vs cold scan: ${report.summary.average_token_reduction_vs_cold_scan}%`,
    `Average token reduction vs targeted search: ${report.summary.average_token_reduction_vs_search}%`,
    `Average file reduction: ${report.summary.average_file_reduction}%`,
    `Average cached speedup vs cold scan: ${report.summary.average_speedup_vs_cold_scan}x`,
    `Average cached speedup vs targeted search: ${report.summary.average_speedup_vs_search}x`,
    `Average cached solution time with Unravl: ${report.summary.average_cached_solution_ms_with_unravl}ms`,
    `Average first-run solution time with Unravl: ${report.summary.average_first_run_solution_ms_with_unravl}ms`,
    `Average search solution time without Unravl: ${report.summary.average_search_solution_ms_without_unravl}ms`,
    '',
    '## Summary',
    '',
    '| Repo | Tasks | Score | Success | Source files | Source tokens | File reduction | Token reduction | Speedup vs scan | Speedup vs search |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const target of report.targets) {
    lines.push(`| ${target.name} | ${target.tasks.length} | ${target.score} | ${Math.round(target.adoption_delta.with_unravl_success_rate * 100)}% | ${target.source_files} | ${target.source_tokens} | ${target.adoption_delta.average_file_reduction_percentage}% | ${target.adoption_delta.average_token_reduction_percentage_vs_cold_scan}% | ${target.adoption_delta.average_estimated_speedup_vs_cold_scan}x | ${target.adoption_delta.average_estimated_speedup_vs_search}x |`);
  }

  lines.push('', '## Task Details', '');
  for (const target of report.targets) {
    lines.push(`### ${target.name}`, '');
    for (const task of target.tasks) {
      const comparison = task.agentic_comparison;
      lines.push(`- ${task.task_label}: ${task.score}/100, success=${task.solution.with_unravl.success ? 'yes' : 'no'}, projected baseline=${Math.round(task.solution.without_unravl_proxy.projected_success_probability * 100)}%`);
      lines.push(`  - Expected: ${task.expected_outcome}`);
      lines.push(`  - With Unravl: ${comparison.with_unravl.total_context_tokens} estimated tokens, ${comparison.with_unravl.files_to_read} files, ${comparison.with_unravl.estimated_cached_solution_ms}ms cached solution, ${comparison.with_unravl.estimated_first_run_solution_ms}ms first-run solution`);
      lines.push(`  - Without Unravl cold scan: ${comparison.without_unravl.cold_scan_tokens} estimated tokens, ${comparison.without_unravl.cold_scan_files} files, ${comparison.without_unravl.cold_scan_estimated_solution_ms}ms estimated solution`);
      lines.push(`  - Without Unravl search: ${comparison.without_unravl.search_strategy_tokens} estimated tokens, ${comparison.without_unravl.search_strategy_files} files, ${comparison.without_unravl.search_strategy_estimated_solution_ms}ms estimated solution`);
      lines.push(`  - Deltas: ${comparison.deltas.cold_scan_token_reduction_percentage}% token reduction vs cold scan, ${comparison.deltas.search_strategy_token_reduction_percentage}% vs search, ${comparison.deltas.estimated_speedup_vs_search}x speedup vs search`);
      if (task.solution.without_unravl_proxy.risk_factors.length > 0) {
        lines.push(`  - Baseline risks: ${task.solution.without_unravl_proxy.risk_factors.join('; ')}`);
      }
    }
    lines.push('');
  }

  const firstTask = report.targets[0]?.tasks[0]?.agentic_comparison.two_agent_protocol;
  if (firstTask) {
    lines.push('## Two-Agent Run Sheet', '');
    lines.push('Record these metrics for each live run:');
    lines.push(...firstTask.metrics_to_record.map(metric => `- ${metric}`));
    lines.push('', '### Agent A: Without Unravl', '', '```text', firstTask.agent_without_unravl_prompt, '```');
    lines.push('', '### Agent B: With Unravl', '', '```text', firstTask.agent_with_unravl_prompt, '```');
  }

  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runAgenticBenchmark({
    repos: args.repos,
    includeFixtures: args.includeFixtures,
    fixtureRoot: args.fixtureRoot,
    task: args.task,
    suite: args.suite,
    includeRealRepos: args.includeRealRepos,
    devRoot: args.devRoot,
    maxTargets: args.maxTargets,
    maxTasksPerRepo: args.maxTasksPerRepo,
  });

  await fs.ensureDir(path.dirname(args.outputPath));
  await fs.writeJson(args.outputPath, report, { spaces: 2 });
  await fs.ensureDir(path.dirname(args.markdownPath));
  await fs.writeFile(args.markdownPath, formatMarkdownReport(report), 'utf8');
  const saved = await saveAgenticBenchmarkReport(report);
  console.log(`Agent usefulness benchmark: ${report.status.toUpperCase()} (${report.score}/100)`);
  console.log(`Tasks: ${report.summary.task_count} | With Unravl success ${Math.round(report.summary.with_unravl_success_rate * 100)}% | Projected baseline success ${Math.round(report.summary.projected_without_unravl_success_rate * 100)}% | Token reduction ${report.summary.average_token_reduction_vs_search}% vs search | Speedup ${report.summary.average_speedup_vs_search}x vs search`);
  for (const target of report.targets) {
    console.log(`${target.status.toUpperCase().padEnd(4)} ${String(target.score).padStart(3)}/100 | ${target.name} | ${target.tasks.length} tasks | ${target.source_files} source files | ${target.adoption_delta.average_file_reduction_percentage}% file reduction | ${target.adoption_delta.average_estimated_speedup_vs_search}x vs search | ${Math.round(target.durationMs / 1000)}s`);
    for (const task of target.tasks.filter(result => result.status !== 'pass').slice(0, 5)) {
      console.log(`  - ${task.task.task_type || 'orient'} ${task.task.target || ''}: ${task.score}/100`);
    }
  }
  console.log(`Report: ${args.outputPath}`);
  console.log(`Markdown: ${args.markdownPath}`);
  console.log(`Persisted MCP report: ${saved.file}`);

  if (report.status === 'fail') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
