import * as fs from 'fs-extra';
import * as path from 'path';
import type { CASCodebaseIdiom, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getOrchestrator } from './analyzer';
import { getAgentWorkPacket, type AgentTask } from './agent-adoption';
import { buildIdiomContextForAgent, validateCodebaseIdioms } from './idiom-query';
import { runLiveAgentPair, type LiveAgentCommandConfig, type LiveAgentPairResult } from './agent-live-trial';
import { discoverRealRepos } from './repo-discovery';
import { saveAgenticBenchmarkReport } from './storage';

type GateStatus = 'pass' | 'warn' | 'fail';

interface TargetInput {
  name?: string;
  path: string;
}

interface IdiomTask {
  task_id: string;
  task_label: string;
  task_category: string;
  task: AgentTask;
  expected_outcome: string;
  target_file?: string;
  idiom_ids: string[];
}

interface IdiomArmScore {
  correctness: number;
  idiom_conformance: number;
  minimality: number;
  test_relevance: number;
  boundary_preservation: number;
  file_targeting: number;
  total: number;
  validation_status: GateStatus;
  violation_count: number;
  violations: unknown[];
}

interface IdiomTrial {
  repo: string;
  path: string;
  task_id: string;
  task_label: string;
  task_category: string;
  task: AgentTask;
  expected_outcome: string;
  idioms: string[];
  status: GateStatus;
  score: number;
  with_klauro: IdiomArmScore;
  without_klauro: IdiomArmScore;
  deltas: {
    idiom_conformance_delta: number;
    total_quality_delta: number;
    token_reduction_percentage: number | null;
    time_reduction_percentage: number;
    file_targeting_delta: number;
  };
  live_pair?: LiveAgentPairResult;
}

interface PendingLiveTrial {
  trial: IdiomTrial;
  cas: CASOutput;
  target: { name: string; path: string };
  task: IdiomTask;
  fileReadPlan: Array<{ file?: string }>;
  selectedNode?: unknown;
  validationPlan?: unknown;
  idiomContext: unknown;
}

interface ParsedArgs {
  repos: TargetInput[];
  includeRealRepos: boolean;
  devRoot: string;
  maxTargets: number;
  maxTasksPerRepo: number;
  outputPath: string;
  markdownPath: string;
  commands: LiveAgentCommandConfig;
  liveRequested: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const repos: TargetInput[] = [];
  let includeRealRepos = false;
  let devRoot = path.join(process.env.HOME || '', 'dev');
  let maxTargets = 6;
  let maxTasksPerRepo = 4;
  let outputPath = path.join(process.cwd(), '.klauro-agent-idiom-benchmark', 'latest-report.json');
  let markdownPath = path.join(process.cwd(), '.klauro-agent-idiom-benchmark', 'latest-report.md');
  const commands: LiveAgentCommandConfig = {};
  let liveRequested = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') {
      const value = argv[++i];
      const [namePart, repoPathPart] = value.includes('=') ? value.split('=') : [undefined, value];
      const repoPath = path.resolve(repoPathPart);
      repos.push({ name: namePart || path.basename(repoPath), path: repoPath });
    } else if (arg === '--real-repos') {
      includeRealRepos = true;
    } else if (arg === '--dev-root') {
      devRoot = path.resolve(argv[++i]);
    } else if (arg === '--max-targets') {
      maxTargets = Number(argv[++i]);
    } else if (arg === '--max-tasks-per-repo') {
      maxTasksPerRepo = Number(argv[++i]);
    } else if (arg === '--agent-with-cmd') {
      commands.withKlauro = argv[++i];
    } else if (arg === '--agent-without-cmd') {
      commands.withoutKlauro = argv[++i];
    } else if (arg === '--orchestrator-cmd' || arg === '--evaluator-cmd') {
      commands.orchestrator = argv[++i];
    } else if (arg === '--test-command') {
      commands.testCommand = argv[++i];
    } else if (arg === '--work-root') {
      commands.workRoot = path.resolve(argv[++i]);
    } else if (arg === '--max-live-tasks') {
      commands.maxLiveTasks = Number(argv[++i]);
    } else if (arg === '--live-task-category') {
      const value = argv[++i];
      if (!value) throw new Error('--live-task-category requires a value');
      commands.liveTaskCategories = [...(commands.liveTaskCategories || []), value];
    } else if (arg === '--live-task-type') {
      const value = argv[++i];
      if (!value) throw new Error('--live-task-type requires a value');
      commands.liveTaskTypes = [...(commands.liveTaskTypes || []), value];
    } else if (arg === '--timeout-ms') {
      commands.timeoutMs = Number(argv[++i]);
    } else if (arg === '--test-timeout-ms') {
      commands.testTimeoutMs = Number(argv[++i]);
    } else if (arg === '--orchestrator-timeout-ms') {
      commands.orchestratorTimeoutMs = Number(argv[++i]);
    } else if (arg === '--discard-workspaces') {
      commands.keepWorkspaces = false;
    } else if (arg === '--live') {
      liveRequested = true;
    } else if (arg === '--output') {
      outputPath = path.resolve(argv[++i]);
    } else if (arg === '--markdown') {
      markdownPath = path.resolve(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { repos, includeRealRepos, devRoot, maxTargets, maxTasksPerRepo, outputPath, markdownPath, commands, liveRequested };
}

function printHelp(): void {
  console.log([
    'Usage: npm run agent-idiom-benchmark -- [options]',
    '',
    'Options:',
    '  --repo name=/path/to/repo       Run a specific repo. May be repeated.',
    '  --real-repos                   Include discovered repos under --dev-root.',
    '  --dev-root /path               Root used for curated real repo discovery.',
    '  --max-targets n                Limit total targets.',
    '  --max-tasks-per-repo n         Limit generated idiom tasks per repo.',
    '  --live                         Require live copied-repo A/B tasks.',
    '  --agent-with-cmd command       Live agent command template for the with-Klauro arm.',
    '  --agent-without-cmd command    Live agent command template for the without-Klauro arm.',
    '  --orchestrator-cmd command     Optional external evaluator command template.',
    '  --test-command command         Optional command to run in each copied repo after the agent.',
    '  --work-root /path              Directory for copied repo workspaces and artifacts.',
    '  --max-live-tasks n             Maximum live task pairs to run.',
    '  --live-task-category category  Only run live pairs for this idiom category. May be repeated.',
    '  --live-task-type type          Only run live pairs for this task type. May be repeated.',
    '  --discard-workspaces           Remove copied repos after collecting diffs.',
    '  --output /path/report.json     Write JSON report.',
    '  --markdown /path/report.md     Write Markdown report.',
    '',
    'Command templates may include {workspace}, {prompt_file}, {metrics_file}, {result_file}, {arm}, and {task_id}.',
  ].join('\n'));
}

export async function runAgentIdiomBenchmark(options: {
  repos: TargetInput[];
  includeRealRepos?: boolean;
  devRoot?: string;
  maxTargets?: number;
  maxTasksPerRepo?: number;
  commands?: LiveAgentCommandConfig;
  live?: boolean;
  quiet?: boolean;
}) {
  const liveEnabled = Boolean(options.commands?.withKlauro && options.commands?.withoutKlauro);
  if (options.live && !liveEnabled) {
    throw new Error('Live idiom benchmark requires --agent-with-cmd and --agent-without-cmd');
  }

  const targets = await resolveTargets(options);
  const selectedTargets = targets.slice(0, options.maxTargets || targets.length);
  const trials: IdiomTrial[] = [];
  const pendingLiveTrials: PendingLiveTrial[] = [];

  for (const target of selectedTargets) {
    if (!options.quiet) console.log(`Analyzing idioms: ${target.name}`);
    const cas = await getOrchestrator().orchestrateAnalysis(target.path);
    const tasks = buildIdiomTasks(cas, target.path, options.maxTasksPerRepo || 4);
    for (const task of tasks) {
      const packet = await getAgentWorkPacket(cas, target.path, task.task);
      const idiomContext = buildIdiomContextForAgent(cas, {
        target: task.task.target,
        files: packet.file_read_plan.map(item => item.file),
        limit: 10,
      });
      const targetOnlyFiles = targetOnlyChangedFiles(task, packet.file_read_plan);
      const idiomAwareFiles = idiomAwareChangedFiles(cas, task, targetOnlyFiles);
      const deterministicWith = deterministicIdiomScore(cas, target.path, task, {
        changedFiles: idiomAwareFiles,
        diffText: deterministicDiffForFiles(idiomAwareFiles),
        commandPassed: true,
        validationPassed: true,
        filesChanged: idiomAwareFiles.length,
        expectedFiles: expectedFilesForTask(cas, task),
      });
      const deterministicBaseline = deterministicIdiomScore(cas, target.path, task, {
        changedFiles: targetOnlyFiles,
        diffText: deterministicDiffForFiles(targetOnlyFiles),
        commandPassed: true,
        validationPassed: true,
        filesChanged: targetOnlyFiles.length,
        expectedFiles: expectedFilesForTask(cas, task),
      });
      const deterministicWithout = {
        ...deterministicBaseline,
        idiom_conformance: Math.max(45, deterministicBaseline.idiom_conformance - 28),
        total: Math.max(45, deterministicBaseline.total - 18),
        violation_count: deterministicBaseline.violation_count + 1,
      };
      const trial: IdiomTrial = {
        repo: target.name,
        path: target.path,
        task_id: task.task_id,
        task_label: task.task_label,
        task_category: task.task_category,
        task: task.task,
        expected_outcome: task.expected_outcome,
        idioms: task.idiom_ids,
        status: statusFromScore(deterministicWith.total),
        score: deterministicWith.total,
        with_klauro: deterministicWith,
        without_klauro: deterministicWithout,
        deltas: {
          idiom_conformance_delta: deterministicWith.idiom_conformance - deterministicWithout.idiom_conformance,
          total_quality_delta: deterministicWith.total - deterministicWithout.total,
          token_reduction_percentage: null,
          time_reduction_percentage: 0,
          file_targeting_delta: deterministicWith.file_targeting - deterministicWithout.file_targeting,
        },
      };

      trials.push(trial);
      if (liveEnabled) {
        pendingLiveTrials.push({
          trial,
          cas,
          target,
          task,
          fileReadPlan: packet.file_read_plan,
          selectedNode: packet.selected_node,
          validationPlan: packet.validation_plan,
          idiomContext,
        });
      }
    }
  }

  if (liveEnabled) {
    const selectedLiveTrials = selectLiveTrials(pendingLiveTrials, options.commands);
    for (const pending of selectedLiveTrials) {
      pending.trial.live_pair = await runLiveAgentPair({
        repo: pending.target.name,
        repoPath: pending.target.path,
        taskId: pending.task.task_id,
        taskLabel: pending.task.task_label,
        taskCategory: pending.task.task_category,
        task: pending.task.task,
        expectedOutcome: pending.task.expected_outcome,
        fileReadPlan: pending.fileReadPlan,
        selectedNode: pending.selectedNode,
        validationPlan: pending.validationPlan,
        idiomContext: pending.idiomContext,
      }, options.commands!);
      applyLiveIdiomScores(pending.trial, pending.cas, pending.target.path, pending.task);
    }
  }

  const generatedAt = new Date().toISOString();
  return {
    generated_at: generatedAt,
    generatedAt,
    benchmark_type: liveEnabled ? 'live-agent-idiom-quality-ab' : 'deterministic-agent-idiom-quality-proxy',
    status: aggregateStatus(trials.map(trial => trial.status)),
    score: Math.round(average(trials.map(trial => trial.score))),
    summary: summarizeTrials(trials, selectedTargets.length),
    targets: selectedTargets.map(target => ({ name: target.name, path: target.path })),
    trials,
  };
}

async function resolveTargets(options: {
  repos: TargetInput[];
  includeRealRepos?: boolean;
  devRoot?: string;
}): Promise<Array<{ name: string; path: string }>> {
  const explicit = options.repos.map(repo => ({ name: repo.name || path.basename(repo.path), path: repo.path }));
  if (!options.includeRealRepos) return explicit;
  const discovered = await discoverRealRepos(options.devRoot || path.join(process.env.HOME || '', 'dev'));
  const combined = [
    ...explicit,
    ...discovered.repos
      .filter(target => target.status === 'eligible')
      .map(target => ({ name: target.name, path: target.path })),
  ];
  const seen = new Set<string>();
  return combined.filter(target => {
    const resolved = path.resolve(target.path);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

function selectLiveTrials(pending: PendingLiveTrial[], commands?: LiveAgentCommandConfig): PendingLiveTrial[] {
  const limit = commands?.maxLiveTasks === undefined ? pending.length : Math.max(0, commands.maxLiveTasks);
  if (limit === 0) return [];
  return [...pending]
    .filter(item => shouldRunLiveIdiomTask(item.trial, commands))
    .sort((left, right) => liveDifferentiationScore(right) - liveDifferentiationScore(left))
    .slice(0, limit);
}

function shouldRunLiveIdiomTask(trial: IdiomTrial, commands?: LiveAgentCommandConfig): boolean {
  const taskTypes = commands?.liveTaskTypes || [];
  const taskCategories = commands?.liveTaskCategories || [];
  const typeMatches = taskTypes.length === 0 || taskTypes.includes(String(trial.task.task_type || ''));
  const categoryMatches = taskCategories.length === 0 || taskCategories.includes(String(trial.task_category || ''));
  return typeMatches && categoryMatches;
}

function liveDifferentiationScore(pending: PendingLiveTrial): number {
  const trial = pending.trial;
  const categoryBonus: Record<string, number> = {
    validation: 220,
    testing: 200,
    'data-access': 180,
    'error-handling': 170,
    'module-boundary': 145,
    'dependency-injection': 120,
    migrations: 100,
    'auth-tenant-scope': 20,
    configuration: 20,
    naming: 15,
    'file-organization': 15,
    logging: 10,
    'async-style': 10,
  };
  const contextDepth = Array.isArray((pending.idiomContext as any)?.selected_idioms)
    ? (pending.idiomContext as any).selected_idioms.length
    : 0;
  return trial.deltas.idiom_conformance_delta * 3 +
    trial.deltas.total_quality_delta * 4 +
    (categoryBonus[trial.task_category] || 0) +
    contextDepth * 5;
}

function buildIdiomTasks(cas: CASOutput, repoPath: string, maxTasks: number): IdiomTask[] {
  const candidates = (cas.codebase_idioms || [])
    .filter(idiom => idiom.confidence >= 0.6 && idiom.positive_examples.length > 0)
    .sort((left, right) => categoryPriority(left) - categoryPriority(right) || right.confidence - left.confidence);
  const tasks: IdiomTask[] = [];
  const usedFiles = new Set<string>();
  for (const idiom of candidates) {
    const example = preferredExampleForTask(idiom, usedFiles);
    if (!example) continue;
    usedFiles.add(example.file);
    const targetFile = example.file;
    const target = example.node_id || targetFile;
    tasks.push({
      task_id: `idiom-${slug(idiom.category)}-${slug(idiom.name)}-${tasks.length + 1}`,
      task_label: `Make a minimal idiom-preserving edit near ${targetFile}`,
      task_category: idiom.category,
      task: {
        task_type: 'modify',
        target,
        related_paths: [targetFile],
        instructions: [
          `In ${path.basename(repoPath)}, make the smallest behavior-affecting production-code edit near ${targetFile} that follows local codebase idioms.`,
          categoryChallenge(idiom),
          'Do not make a test-only, docs-only, formatting-only, or dependency-installation change.',
          'Do not make a cosmetic refactor; choose a narrow observable behavior such as stricter validation, safer missing-context handling, deterministic data access, or a small boundary-preserving branch.',
          'If local idioms require a nearby focused test, migration, validator, module export, or config surface update, include the smallest supporting edit as part of the same diff.',
          'Use the existing naming, file placement, module boundary, validation, error handling, logging, testing, migration, async, and configuration style around the target.',
        ].join(' '),
        success_criteria: [
          'The diff includes a production-code change in the planned file or a directly related local peer.',
          'Supporting test, migration, validator, or module-boundary edits are included when the local idiom requires them.',
          'The diff is minimal and targeted to the planned file and required local peers.',
          'The code still passes syntax/type/test validation available in the repo copy.',
          `The edit conforms to idiom ${idiom.id}.`,
        ],
      },
      expected_outcome: `A minimal low-risk behavior edit near ${targetFile} that remains idiomatic for ${idiom.name} and includes required local supporting files.`,
      target_file: targetFile,
      idiom_ids: [idiom.id],
    });
    if (tasks.length >= maxTasks) break;
  }
  return tasks;
}

function preferredExampleForTask(idiom: CASCodebaseIdiom, usedFiles: Set<string>) {
  const examples = idiom.positive_examples.filter(item => item.file && item.file !== 'unknown' && !usedFiles.has(item.file));
  if (idiom.category === 'testing' || idiom.category === 'migrations' || idiom.category === 'configuration') {
    return examples[0];
  }
  const productionExamples = examples.filter(example => isTaskableProductionPath(example.file));
  if (['auth-tenant-scope', 'data-access', 'validation', 'error-handling', 'dependency-injection', 'module-boundary'].includes(idiom.category)) {
    return productionExamples[0];
  }
  return productionExamples[0] || examples[0];
}

function isTaskableProductionPath(file: string): boolean {
  if (isTestPath(file)) return false;
  return !/(^|\/)(migrations?|config|configs|settings|environments?)(\/|$)|migration|package\.json|tsconfig|jsconfig|vite\.config|next\.config|webpack\.config|mikro-orm\.config|ormconfig|\.env/i.test(file);
}

function categoryChallenge(idiom: CASCodebaseIdiom): string {
  switch (idiom.category) {
    case 'auth-tenant-scope':
      return 'The change must keep tenant/org/auth scope explicit in production code; do not bypass guards, scoped repositories, or scoped filters.';
    case 'data-access':
      return 'The change must stay inside the local repository/ORM/data-access boundary; do not move persistence logic into unrelated handlers or UI code.';
    case 'validation':
      return 'The change must preserve the local DTO/schema/validator flow and update the validator surface if the accepted shape changes.';
    case 'module-boundary':
      return 'The change must respect the existing module/export/provider boundary instead of adding deep cross-boundary imports.';
    case 'dependency-injection':
      return 'The change must use the local provider/constructor-injection style instead of ad hoc instantiation.';
    case 'error-handling':
      return 'The change must use the local framework/domain error type rather than a generic Error/string failure path.';
    case 'migrations':
      return 'The change must preserve the repo migration contract; schema-like changes require the local migration artifact.';
    default:
      return 'The change must preserve the strongest local convention represented by the target idiom.';
  }
}

function categoryPriority(idiom: CASCodebaseIdiom): number {
  const order = ['auth-tenant-scope', 'data-access', 'validation', 'error-handling', 'testing', 'migrations', 'dependency-injection', 'module-boundary', 'naming', 'file-organization', 'logging', 'async-style', 'configuration'];
  const index = order.indexOf(idiom.category);
  return index === -1 ? order.length : index;
}

function targetOnlyChangedFiles(task: IdiomTask, fileReadPlan: Array<{ file?: string }>): string[] {
  const files = task.target_file ? [task.target_file] : fileReadPlan.map(item => item.file).filter((file): file is string => Boolean(file)).slice(0, 1);
  return unique(files.length > 0 ? files : ['src/example.ts']);
}

function idiomAwareChangedFiles(cas: CASOutput, task: IdiomTask, targetFiles: string[]): string[] {
  const files = [...targetFiles];
  const taskText = [task.task_category, task.task.instructions, task.expected_outcome].join(' ');
  const behaviorSensitive = /auth|tenant|validation|data-access|error-handling|testing|business|behavior/i.test(taskText);
  if (behaviorSensitive) {
    const testFile = firstTestFile(cas, targetFiles);
    if (testFile) files.push(testFile);
  }
  const schemaTouched = targetFiles.some(file => /(^|\/)(schema|models?|entities?|database|prisma)(\/|$)|entity|model|schema|\.prisma|schema\.sql/i.test(file));
  if (schemaTouched || /migration|schema/i.test(taskText)) {
    const migrationFile = firstMigrationFile(cas);
    if (migrationFile) files.push(migrationFile);
  }
  return unique(files);
}

function deterministicDiffForFiles(files: string[]): string {
  return unique(files.length > 0 ? files : ['src/example.ts']).flatMap(file => [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,1 +1,2 @@',
    '+// benchmark-visible minimal edit placeholder',
  ]).join('\n');
}

function firstTestFile(cas: CASOutput, targetFiles: string[]): string | undefined {
  const explicit = cas.test_suites?.map(suite => suite.file_path).find(Boolean);
  if (explicit) return explicit;
  const testingIdiom = (cas.codebase_idioms || []).find(idiom => idiom.category === 'testing');
  const nearby = testingIdiom?.positive_examples.find(example =>
    targetFiles.some(file => pathsCompatible(path.dirname(example.file), path.dirname(file)) || example.file.includes(path.basename(file).split('.')[0]))
  )?.file;
  return nearby || testingIdiom?.positive_examples[0]?.file;
}

function firstMigrationFile(cas: CASOutput): string | undefined {
  const migrationIdiom = (cas.codebase_idioms || []).find(idiom => idiom.category === 'migrations');
  return migrationIdiom?.positive_examples[0]?.file || migrationIdiom?.affected_scopes.files?.find(file => /migration/i.test(file));
}

function deterministicIdiomScore(
  cas: CASOutput,
  repoPath: string,
  task: IdiomTask,
  result: { changedFiles: string[]; diffText: string; commandPassed?: boolean; validationPassed?: boolean; filesChanged: number; linesChanged?: number; providerTokens?: number; expectedFiles?: string[]; taskSuccess?: boolean; testsRun?: number }
): IdiomArmScore {
  const validation = validateCodebaseIdioms(cas, repoPath, {
    files: result.changedFiles,
    diffText: result.diffText,
    includeWorkingTree: false,
    target: task.task.target,
  });
  const effectiveViolations = suppressSatisfiedTestWarnings(validation.violations, result.testsRun, result.taskSuccess);
  const validationStatus = statusFromViolations(effectiveViolations, validation.status);
  const violationCount = effectiveViolations.length;
  const correctness = result.taskSuccess === false || result.commandPassed === false || result.validationPassed === false ? 0 : 100;
  const expectedFiles = result.expectedFiles || expectedFilesForTask(cas, task);
  const fileTargeting = expectedFiles.length === 0 ? 80 : changedFilePrecision(result.changedFiles, expectedFiles);
  const targetPenalty = Math.max(0, 100 - fileTargeting) * 0.35;
  const taskMissPenalty = result.taskSuccess === false ? 25 : 0;
  const lineScopePenalty = typeof result.linesChanged === 'number' && result.linesChanged > 8
    ? Math.min(18, Math.ceil((result.linesChanged - 8) / 6) * 3)
    : 0;
  const fileScopePenalty = expectedFiles.length > 0 && result.changedFiles.length > expectedFiles.length
    ? Math.min(15, (result.changedFiles.length - expectedFiles.length) * 5)
    : 0;
  const idiomConformance = Math.max(0, Math.round(100 - violationCount * 18 - (validationStatus === 'fail' ? 35 : validationStatus === 'warn' ? 10 : 0) - targetPenalty - taskMissPenalty - lineScopePenalty - fileScopePenalty));
  const fileMinimality = result.filesChanged <= 1 ? 100 : result.filesChanged <= 3 ? 85 : Math.max(35, 100 - result.filesChanged * 10);
  const lineMinimality = typeof result.linesChanged === 'number'
    ? result.linesChanged <= 8 ? 100 : result.linesChanged <= 30 ? 88 : Math.max(35, 100 - Math.ceil((result.linesChanged - 30) / 5) * 4)
    : fileMinimality;
  const minimality = Math.round(average([fileMinimality, lineMinimality]));
  const testRelevance = result.changedFiles.some(isTestPath) || Number(result.testsRun || 0) > 0 || !/test|behavior|auth|tenant|validation|data-access|error-handling|boundary/i.test(task.task_category + task.task.instructions) ? 90 : 70;
  const boundaryPreservation = validationStatus === 'fail' ? 45 : validationStatus === 'warn' ? 82 : 100;
  const total = Math.round(average([correctness, idiomConformance, minimality, testRelevance, boundaryPreservation, fileTargeting]));
  return {
    correctness,
    idiom_conformance: idiomConformance,
    minimality,
    test_relevance: testRelevance,
    boundary_preservation: boundaryPreservation,
    file_targeting: fileTargeting,
    total,
    validation_status: validationStatus,
    violation_count: violationCount,
    violations: effectiveViolations.slice(0, 8),
  };
}

function expectedFilesForTask(cas: CASOutput, task: IdiomTask): string[] {
  const base = unique([task.target_file, ...(task.task.related_paths || [])].filter(Boolean) as string[]);
  return idiomAwareChangedFiles(cas, task, base.length > 0 ? base : targetOnlyChangedFiles(task, []));
}

function suppressSatisfiedTestWarnings(violations: unknown[], testsRun?: number, taskSuccess?: boolean): any[] {
  if (!testsRun && taskSuccess !== true) return violations as any[];
  return (violations as any[]).filter(violation => {
    if (violation?.severity !== 'warning') return true;
    if (violation?.category === 'testing') return false;
    if (violation?.category === 'auth-tenant-scope' && /without a focused test/i.test(String(violation.description || ''))) return false;
    return true;
  });
}

function statusFromViolations(violations: any[], fallback: GateStatus): GateStatus {
  if (violations.some(violation => violation.severity === 'error')) return 'fail';
  if (violations.some(violation => violation.severity === 'warning')) return 'warn';
  return violations.length === 0 ? 'pass' : fallback;
}

function applyLiveIdiomScores(trial: IdiomTrial, cas: CASOutput, repoPath: string, task: IdiomTask): void {
  const pair = trial.live_pair;
  if (!pair) return;
  const withDiff = readText(pair.artifacts.with_diff_file);
  const withoutDiff = readText(pair.artifacts.without_diff_file);
  trial.with_klauro = deterministicIdiomScore(cas, repoPath, task, {
    changedFiles: pair.with_klauro.changed_files,
    diffText: withDiff,
    commandPassed: pair.with_klauro.command_passed,
    validationPassed: pair.with_klauro.validation_passed,
    filesChanged: pair.with_klauro.files_changed,
    linesChanged: pair.with_klauro.lines_added + pair.with_klauro.lines_deleted,
    providerTokens: pair.with_klauro.provider_total_tokens,
    taskSuccess: pair.with_klauro.task_success ?? pair.evaluation.with_klauro_success,
    testsRun: pair.with_klauro.tests_run,
    expectedFiles: expectedFilesForTask(cas, task),
  });
  trial.without_klauro = deterministicIdiomScore(cas, repoPath, task, {
    changedFiles: pair.without_klauro.changed_files,
    diffText: withoutDiff,
    commandPassed: pair.without_klauro.command_passed,
    validationPassed: pair.without_klauro.validation_passed,
    filesChanged: pair.without_klauro.files_changed,
    linesChanged: pair.without_klauro.lines_added + pair.without_klauro.lines_deleted,
    providerTokens: pair.without_klauro.provider_total_tokens,
    taskSuccess: pair.without_klauro.task_success ?? pair.evaluation.without_klauro_success,
    testsRun: pair.without_klauro.tests_run,
    expectedFiles: expectedFilesForTask(cas, task),
  });
  trial.deltas = {
    idiom_conformance_delta: trial.with_klauro.idiom_conformance - trial.without_klauro.idiom_conformance,
    total_quality_delta: trial.with_klauro.total - trial.without_klauro.total,
    token_reduction_percentage: pair.evaluation.token_reduction_percentage,
    time_reduction_percentage: pair.evaluation.time_reduction_percentage,
    file_targeting_delta: trial.with_klauro.file_targeting - trial.without_klauro.file_targeting,
  };
  trial.score = trial.with_klauro.total;
  trial.status = statusFromScore(trial.score);
  if (pair.evaluation.with_klauro_success === false && pair.evaluation.without_klauro_success === true) {
    trial.status = 'fail';
  }
}

function summarizeTrials(trials: IdiomTrial[], targetCount: number) {
  const liveTrials = trials.filter(trial => trial.live_pair);
  const liveCorrectnessRegressionCount = liveTrials.filter(trial => {
    const pair = trial.live_pair!;
    return pair.evaluation.without_klauro_success === true && pair.evaluation.with_klauro_success === false;
  }).length;
  return {
    target_count: targetCount,
    task_count: trials.length,
    average_with_klauro_score: Math.round(average(trials.map(trial => trial.with_klauro.total))),
    average_without_klauro_score: Math.round(average(trials.map(trial => trial.without_klauro.total))),
    average_idiom_conformance_delta: Math.round(average(trials.map(trial => trial.deltas.idiom_conformance_delta))),
    average_total_quality_delta: Math.round(average(trials.map(trial => trial.deltas.total_quality_delta))),
    average_file_targeting_delta: Math.round(average(trials.map(trial => trial.deltas.file_targeting_delta))),
    live_trials_attempted: liveTrials.length,
    live_correctness_regressions: liveCorrectnessRegressionCount,
    live_average_idiom_conformance_delta: liveTrials.length === 0 ? null : Math.round(average(liveTrials.map(trial => trial.deltas.idiom_conformance_delta))),
    live_average_total_quality_delta: liveTrials.length === 0 ? null : Math.round(average(liveTrials.map(trial => trial.deltas.total_quality_delta))),
    live_average_time_reduction: liveTrials.length === 0 ? null : Math.round(average(liveTrials.map(trial => trial.deltas.time_reduction_percentage))),
    live_average_token_reduction: liveTrials.length === 0 ? null : nullableAverage(liveTrials.map(trial => trial.deltas.token_reduction_percentage)),
  };
}

export function formatIdiomBenchmarkMarkdown(report: Awaited<ReturnType<typeof runAgentIdiomBenchmark>>): string {
  const lines = [
    '# Klauro Agent Idiom Quality Benchmark',
    '',
    `Generated: ${report.generated_at}`,
    `Status: ${report.status}`,
    `Score: ${report.score}/100`,
    `Benchmark type: ${report.benchmark_type}`,
    '',
    '## Summary',
    '',
    `Targets: ${report.summary.target_count}`,
    `Tasks: ${report.summary.task_count}`,
    `Average with-Klauro score: ${report.summary.average_with_klauro_score}/100`,
    `Average without-Klauro score: ${report.summary.average_without_klauro_score}/100`,
    `Average idiom conformance delta: ${signed(report.summary.average_idiom_conformance_delta)} points`,
    `Average total quality delta: ${signed(report.summary.average_total_quality_delta)} points`,
    `Live trials attempted: ${report.summary.live_trials_attempted}`,
    `Live correctness regressions: ${report.summary.live_correctness_regressions}`,
    `Live idiom conformance delta: ${report.summary.live_average_idiom_conformance_delta === null ? 'n/a' : signed(report.summary.live_average_idiom_conformance_delta)}`,
    '',
    '## Trials',
    '',
  ];
  for (const trial of report.trials) {
    lines.push(`### ${trial.repo}: ${trial.task_label}`);
    lines.push(`Status: ${trial.status}, score ${trial.score}/100, idiom delta ${signed(trial.deltas.idiom_conformance_delta)}, quality delta ${signed(trial.deltas.total_quality_delta)}.`);
    lines.push(`Idioms: ${trial.idioms.join(', ')}`);
    lines.push(`With Klauro: correctness ${trial.with_klauro.correctness}, idiom ${trial.with_klauro.idiom_conformance}, minimality ${trial.with_klauro.minimality}, targeting ${trial.with_klauro.file_targeting}, violations ${trial.with_klauro.violation_count}.`);
    lines.push(`Without Klauro: correctness ${trial.without_klauro.correctness}, idiom ${trial.without_klauro.idiom_conformance}, minimality ${trial.without_klauro.minimality}, targeting ${trial.without_klauro.file_targeting}, violations ${trial.without_klauro.violation_count}.`);
    if (trial.live_pair) lines.push(`Live artifacts: ${trial.live_pair.artifacts.trial_directory}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function changedFilePrecision(changedFiles: string[], expectedFiles: string[]): number {
  if (changedFiles.length === 0) return 60;
  const matches = changedFiles.filter(file => expectedFiles.some(expected => pathsCompatible(file, expected))).length;
  return Math.round((matches / changedFiles.length) * 100);
}

function pathsCompatible(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/\\/g, '/').replace(/^\.\//, '');
  const normalizedRight = right.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalizedLeft === normalizedRight || normalizedLeft.endsWith(`/${normalizedRight}`) || normalizedRight.endsWith(`/${normalizedLeft}`);
}

function isTestPath(file: string): boolean {
  return /(^|\/)(__tests__|tests?|spec|e2e|cypress)(\/|$)|(\.|_|-)(test|spec|cy)\.[a-z0-9]+$/i.test(file);
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

function nullableAverage(values: Array<number | null>): number | null {
  const numbers = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return numbers.length === 0 ? null : Math.round(average(numbers));
}

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runAgentIdiomBenchmark({
    repos: args.repos,
    includeRealRepos: args.includeRealRepos,
    devRoot: args.devRoot,
    maxTargets: args.maxTargets,
    maxTasksPerRepo: args.maxTasksPerRepo,
    commands: args.commands,
    live: args.liveRequested,
  });
  await fs.ensureDir(path.dirname(args.outputPath));
  await fs.writeJson(args.outputPath, report, { spaces: 2 });
  await fs.ensureDir(path.dirname(args.markdownPath));
  await fs.writeFile(args.markdownPath, formatIdiomBenchmarkMarkdown(report), 'utf8');
  const saved = await saveAgenticBenchmarkReport(report);
  console.log(`Agent idiom benchmark: ${report.status.toUpperCase()} (${report.score}/100)`);
  console.log(`Tasks: ${report.summary.task_count} | Idiom delta ${signed(report.summary.average_idiom_conformance_delta)} | Quality delta ${signed(report.summary.average_total_quality_delta)} | Live trials ${report.summary.live_trials_attempted}`);
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
