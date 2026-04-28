import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';
import { getOrchestrator } from './analyzer';
import { getAgentWorkPacket, type AgentTask } from './agent-adoption';
import { loadTruthExpectation, type AnalysisTruthExpectation } from './analysis-mastery';
import type { CASOutput } from '../../backend/src/types/cas.types';

type GateStatus = 'pass' | 'warn' | 'fail';

interface BenchmarkTarget {
  name: string;
  path: string;
  expectation: AnalysisTruthExpectation;
}

interface TaskScore {
  task: AgentTask;
  status: GateStatus;
  score: number;
  selected_node?: unknown;
  file_read_plan: unknown[];
  baseline: {
    cold_repo_files: number;
    planned_files: number;
    file_reduction_percentage: number;
  };
  gates: Array<{ id: string; status: GateStatus; score: number; detail: string }>;
}

function parseArgs(argv: string[]) {
  const repos: BenchmarkTarget[] = [];
  let fixtureRoot = path.join(process.cwd(), 'fixtures', 'analysis-truth');
  let outputPath = path.join(process.cwd(), '.unravl-agent-benchmark', 'latest-report.json');
  let includeFixtures = true;

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
    } else if (arg === '--no-fixtures') {
      includeFixtures = false;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { repos, fixtureRoot, outputPath, includeFixtures };
}

function printHelp(): void {
  console.log([
    'Usage: npm run agent-benchmark -- [options]',
    '',
    'Options:',
    '  --repo name=/path/to/repo   Run a specific repo. May be repeated.',
    '  --fixture-root /path       Built-in analysis-truth fixture root.',
    '  --output /path/report.json Write JSON report.',
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

async function sourceFileCount(projectPath: string): Promise<number> {
  const files = await glob(['**/*.{ts,tsx,js,jsx,py,rs,go,java,cs,php,prisma}'], {
    cwd: projectPath,
    ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/target/**', '**/coverage/**'],
    nodir: true,
  });
  return files.length;
}

function tasksForExpectation(expectation: AnalysisTruthExpectation): AgentTask[] {
  const targets = [
    ...(expectation.nodes || []).slice(0, 3).map(node => node.name),
    ...(expectation.routes || []).slice(0, 2).map(route => route.handler || route.path),
  ].filter(Boolean) as string[];

  const uniqueTargets = [...new Set(targets)].slice(0, 4);
  const tasks: AgentTask[] = uniqueTargets.map(target => ({ task_type: 'modify', target }));
  if (tasks.length === 0) tasks.push({ task_type: 'orient' });
  tasks.push({ task_type: 'debug', target: uniqueTargets[0] });
  return tasks;
}

function scoreTask(cas: CASOutput, projectPath: string, task: AgentTask, filesInRepo: number): TaskScore {
  const packet = getAgentWorkPacket(cas, projectPath, task);
  const planFiles = packet.file_read_plan.map(item => String(item.file)).filter(Boolean);
  const selectedFile = packet.selected_node?.file ? String(packet.selected_node.file) : undefined;
  const reduction = filesInRepo === 0 ? 0 : Math.max(0, Math.round(((filesInRepo - planFiles.length) / filesInRepo) * 100));
  const gates = [
    gate('target-resolved', Boolean(packet.selected_node) || task.task_type === 'orient', packet.selected_node?.name || 'not resolved'),
    gate('file-plan-present', planFiles.length > 0, `${planFiles.length} files`),
    gate('file-plan-narrower-than-repo', filesInRepo <= 1 || planFiles.length < filesInRepo, `${planFiles.length}/${filesInRepo}`),
    gate('selected-file-included', !selectedFile || planFiles.some(file => pathsCompatible(file, selectedFile)), selectedFile || 'no selected file'),
    gate('mcp-followups-present', packet.next_mcp_calls.length > 0, `${packet.next_mcp_calls.length} calls`),
    gate('beats-cold-repo-read', beatsColdRepoRead(filesInRepo, planFiles.length, reduction), `${reduction}% fewer files`),
  ];
  const score = Math.round(gates.reduce((sum, result) => sum + result.score, 0) / gates.length);

  return {
    task,
    status: statusFromScore(score),
    score,
    selected_node: packet.selected_node,
    file_read_plan: packet.file_read_plan,
    baseline: {
      cold_repo_files: filesInRepo,
      planned_files: planFiles.length,
      file_reduction_percentage: reduction,
    },
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

function pathsCompatible(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/\\/g, '/');
  const normalizedRight = right.replace(/\\/g, '/');
  return normalizedLeft === normalizedRight || normalizedLeft.endsWith(`/${normalizedRight}`) || normalizedRight.endsWith(`/${normalizedLeft}`);
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

async function analyzeTarget(target: BenchmarkTarget) {
  const startedAt = Date.now();
  const cas = await getOrchestrator().orchestrateAnalysis(target.path);
  const filesInRepo = await sourceFileCount(target.path);
  const tasks = tasksForExpectation(target.expectation);
  const taskScores = tasks.map(task => scoreTask(cas, target.path, task, filesInRepo));
  const score = Math.round(average(taskScores.map(task => task.score)));
  const averageReduction = Math.round(average(taskScores.map(task => task.baseline.file_reduction_percentage)));
  return {
    name: target.name,
    path: target.path,
    status: aggregateStatus(taskScores.map(task => task.status)),
    score,
    durationMs: Date.now() - startedAt,
    source_files: filesInRepo,
    adoption_delta: {
      average_file_reduction_percentage: averageReduction,
      cold_repo_files_per_task: filesInRepo,
      planned_files_per_task: Math.round(average(taskScores.map(task => task.baseline.planned_files))),
    },
    tasks: taskScores,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const targets = [
    ...(args.includeFixtures ? await fixtureTargets(args.fixtureRoot) : []),
    ...args.repos,
  ];
  if (targets.length === 0) throw new Error('No agent benchmark targets configured');

  const reports = [];
  for (const target of targets) {
    console.log(`Benchmarking ${target.name}: ${target.path}`);
    reports.push(await analyzeTarget(target));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    status: aggregateStatus(reports.map(target => target.status)),
    score: Math.round(average(reports.map(target => target.score))),
    targets: reports,
  };

  await fs.ensureDir(path.dirname(args.outputPath));
  await fs.writeJson(args.outputPath, report, { spaces: 2 });
  console.log(`Agent usefulness benchmark: ${report.status.toUpperCase()} (${report.score}/100)`);
  for (const target of reports) {
    console.log(`${target.status.toUpperCase().padEnd(4)} ${String(target.score).padStart(3)}/100 | ${target.name} | ${target.source_files} source files | ${target.adoption_delta.average_file_reduction_percentage}% file reduction | ${Math.round(target.durationMs / 1000)}s`);
    for (const task of target.tasks.filter(result => result.status !== 'pass').slice(0, 5)) {
      console.log(`  - ${task.task.task_type || 'orient'} ${task.task.target || ''}: ${task.score}/100`);
    }
  }
  console.log(`Report: ${args.outputPath}`);

  if (report.status === 'fail') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
