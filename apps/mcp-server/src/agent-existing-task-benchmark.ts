#!/usr/bin/env tsx
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { analyzeProjectIncremental } from './analyzer';
import { getAgentWorkPacket } from './agent-adoption';
import { validateAgentChange } from './agent-workflow';
import { runLiveAgentPair, type LiveAgentCommandConfig, type LiveAgentPairResult } from './agent-live-trial';
import { saveAgenticBenchmarkReport } from './storage';

type BenchmarkStatus = 'pass' | 'warn' | 'fail';
type TaskFamily =
  | 'bug-diagnosis-root-cause'
  | 'bug-fix-live-edits'
  | 'real-product-enhancements'
  | 'architectural-change-refactor'
  | 'monolith-decomposition'
  | 'schema-migration-changes'
  | 'auth-tenant-boundary-changes'
  | 'auth-system-replacement'
  | 'mfa-security-enhancement'
  | 'test-addition-coverage'
  | 'performance-fixes'
  | 'cross-repo-contract-changes'
  | 'large-feature-integration';

interface LiveFileCheck {
  file: string;
  patterns: string[];
  absent_patterns?: string[];
}

interface SeededScenario {
  id: string;
  family: TaskFamily;
  title: string;
  task: {
    task_type: 'debug' | 'modify' | 'trace';
    target: string;
    instructions: string;
    success_criteria: string[];
  };
  files: Record<string, string>;
  expected_files: string[];
  expected_terms: string[];
  changed_files: string[];
  diff_text: string;
  live_checks: LiveFileCheck[];
  semantic_rules: {
    required_changed_files?: string[];
    forbidden_changed_files?: string[];
    max_changed_files?: number;
    required_diff_patterns?: string[];
    forbidden_diff_patterns?: string[];
    require_test_change?: boolean;
    require_production_change?: boolean;
    allow_only_changed_files?: boolean;
  };
}

interface ScenarioResult {
  id: string;
  family: TaskFamily;
  title: string;
  status: BenchmarkStatus;
  score: number;
  repo_path: string;
  with_klauro: {
    score: number;
    packet_tokens: number;
    file_hit_rate: number;
    first_read_file_hit_rate: number;
    term_hit_rate: number;
    validation_status: string;
    first_files: string[];
  };
  without_klauro_proxy: {
    score: number;
    estimated_files_to_read: number;
    estimated_tokens: number;
  };
  index_retrieval_baseline: {
    score: number;
    retrieved_files: string[];
    file_precision: number;
    file_recall: number;
    estimated_tokens: number;
  };
  deltas: {
    score_delta: number;
    file_reduction_percentage: number;
    token_reduction_percentage: number;
  };
  findings: string[];
  live_pair?: LiveAgentPairResult;
  live_summary?: {
    status: BenchmarkStatus;
    with_score: number;
    without_score: number;
    quality_delta: number;
    token_reduction_percentage: number | null;
    time_reduction_percentage: number;
    changed_file_precision_delta: number;
  };
}

interface BenchmarkReport {
  generated_at: string;
  benchmark_type: 'seeded-existing-project-task-proof';
  status: BenchmarkStatus;
  score: number;
  summary: {
    proof_strength: 'deterministic-proxy' | 'live-agent-proof';
    claim_limit: string;
    scenario_count: number;
    family_count: number;
    passing_scenarios: number;
    average_score_delta: number;
    average_file_reduction_percentage: number;
    average_token_reduction_percentage: number;
    live_scenarios: number;
    live_passing_scenarios: number;
    average_live_quality_delta: number;
    average_live_token_reduction_percentage: number;
    average_index_retrieval_file_recall: number;
    average_index_retrieval_tokens: number;
    klauro_vs_index_retrieval_token_reduction_percentage: number;
    families: Record<TaskFamily, { scenarios: number; average_score: number; status: BenchmarkStatus }>;
  };
  scenarios: ScenarioResult[];
}

interface Args {
  outputRoot: string;
  reportPath: string | null;
  markdownPath: string | null;
  live: boolean;
  liveConfig: LiveAgentCommandConfig;
  withoutArmRetrieval: boolean;
  realRepoPath: string | null;
  realTaskId: string | null;
}

interface RealRepoScenario {
  id: string;
  family: TaskFamily;
  title: string;
  task: SeededScenario['task'];
  expected_files: string[];
  expected_terms: string[];
  changed_files: string[];
  live_checks: LiveFileCheck[];
  semantic_rules: SeededScenario['semantic_rules'];
  lint_php?: boolean;
}

interface RealRepoBenchmarkReport {
  generated_at: string;
  benchmark_type: 'real-repo-existing-task-live-ab';
  status: BenchmarkStatus;
  repo: string;
  repo_path: string;
  scenario_id: string;
  scenario_title: string;
  family: TaskFamily;
  without_arm_retrieval: boolean;
  with_klauro: {
    packet_tokens: number;
    first_files: string[];
  };
  index_retrieval_baseline: ScenarioResult['index_retrieval_baseline'];
  live_summary: NonNullable<ScenarioResult['live_summary']>;
  live_pair: LiveAgentPairResult;
}

const REAL_REPO_SCENARIOS: RealRepoScenario[] = [
  {
    id: 'unroutable-notification-channel-skip-retry',
    family: 'real-product-enhancements',
    title: 'Stop retry-queueing notifications whose channel has no registered sender',
    task: {
      task_type: 'modify',
      target: 'notification sender routing for channels without a registered sender',
      instructions: [
        'When NotificationSenderFinder cannot find a sender for a notification channel it throws a generic InvalidArgumentException, and NotificationService treats that like a transient delivery failure: the listener enters the retry pipeline and is re-dispatched with growing delays for up to 12 hours even though a missing sender is a permanent configuration problem.',
        'Introduce a dedicated UnroutableNotificationChannelException in the App\\NotificationSystem\\Service\\Sender namespace (same placement style as the sibling ExternalServiceException), throw it from NotificationSenderFinder::getSender instead of InvalidArgumentException, and make the send loop in NotificationService catch it before the generic Throwable handler: log an error and move on to the next listener without dispatching a retry and without deleting rate limiter state.',
        'Keep the existing logging style and keep the existing retry behavior for every other failure type.',
      ].join(' '),
      success_criteria: [
        'UnroutableNotificationChannelException exists in the Sender namespace and NotificationSenderFinder::getSender throws it when no sender matches the channel.',
        'The NotificationService send loop catches the new exception specifically, logs it, and skips the listener without queueing a retry.',
        'Every other Throwable failure keeps the existing retry pipeline and rate limiter cleanup.',
      ],
    },
    expected_files: [
      'src/NotificationSystem/Service/Sender/NotificationSenderFinder.php',
      'src/NotificationSystem/Service/NotificationService.php',
      'src/NotificationSystem/Service/NotificationSenders.php',
    ],
    expected_terms: ['notification', 'sender', 'channel', 'retry', 'exception'],
    changed_files: [
      'src/NotificationSystem/Service/Sender/NotificationSenderFinder.php',
      'src/NotificationSystem/Service/Sender/UnroutableNotificationChannelException.php',
      'src/NotificationSystem/Service/NotificationService.php',
    ],
    live_checks: [
      { file: 'src/NotificationSystem/Service/Sender/UnroutableNotificationChannelException.php', patterns: ['class UnroutableNotificationChannelException'] },
      { file: 'src/NotificationSystem/Service/Sender/NotificationSenderFinder.php', patterns: ['UnroutableNotificationChannelException'], absent_patterns: ['InvalidArgumentException'] },
      { file: 'src/NotificationSystem/Service/NotificationService.php', patterns: ['catch\\s*\\([^)]*UnroutableNotificationChannelException'] },
    ],
    semantic_rules: {
      required_changed_files: [
        'src/NotificationSystem/Service/Sender/NotificationSenderFinder.php',
        'src/NotificationSystem/Service/Sender/UnroutableNotificationChannelException.php',
        'src/NotificationSystem/Service/NotificationService.php',
      ],
      max_changed_files: 6,
      required_diff_patterns: [
        'class UnroutableNotificationChannelException',
        'throw new UnroutableNotificationChannelException',
        'catch\\s*\\([^)]*UnroutableNotificationChannelException',
      ],
      forbidden_diff_patterns: ['throw new \\\\?InvalidArgumentException'],
    },
    lint_php: true,
  },
  {
    id: 'report-not-found-readable-error',
    family: 'bug-fix-live-edits',
    title: 'Return a readable API error when a report name does not resolve',
    task: {
      task_type: 'modify',
      target: 'unknown report name error handling in the report system',
      instructions: [
        'When ReportFinder::getReport cannot match the requested report name it throws a generic \\InvalidArgumentException, which the API renders as an opaque 500; the FOS REST configuration in config/packages/fos_rest.yaml only maps App\\Exception\\ApiReadableException to a readable 400 response.',
        'Introduce a dedicated ReportNotFoundException in the App\\ReportSystem namespace (file src/ReportSystem/ReportNotFoundException.php, next to ReportFinder) that extends App\\Exception\\ApiReadableException, and throw it from ReportFinder::getReport for the unknown-name case so API clients get a readable 400 that still includes the requested report name.',
        'Keep the existing LogicException for reports that implement neither time-sensitivity contract, and do not change any controller or the FOS REST configuration.',
      ].join(' '),
      success_criteria: [
        'ReportNotFoundException exists in the App\\ReportSystem namespace and extends ApiReadableException.',
        'ReportFinder::getReport throws ReportNotFoundException with the requested name when no report matches, and no longer throws InvalidArgumentException.',
        'The LogicException for reports missing both time-sensitivity contracts is unchanged, and no controllers or configuration files change.',
      ],
    },
    expected_files: [
      'src/ReportSystem/ReportFinder.php',
      'src/Exception/ApiReadableException.php',
      'config/packages/fos_rest.yaml',
    ],
    expected_terms: ['report', 'finder', 'exception', 'readable', 'name'],
    changed_files: [
      'src/ReportSystem/ReportFinder.php',
      'src/ReportSystem/ReportNotFoundException.php',
    ],
    live_checks: [
      { file: 'src/ReportSystem/ReportNotFoundException.php', patterns: ['class ReportNotFoundException', 'extends\\s+(\\\\?App\\\\Exception\\\\)?ApiReadableException'] },
      { file: 'src/ReportSystem/ReportFinder.php', patterns: ['throw new ReportNotFoundException'], absent_patterns: ['InvalidArgumentException'] },
    ],
    semantic_rules: {
      required_changed_files: [
        'src/ReportSystem/ReportFinder.php',
        'src/ReportSystem/ReportNotFoundException.php',
      ],
      forbidden_changed_files: ['config/packages/fos_rest.yaml'],
      max_changed_files: 4,
      required_diff_patterns: [
        'class ReportNotFoundException',
        'ApiReadableException',
        'throw new ReportNotFoundException',
      ],
      forbidden_diff_patterns: ['throw new \\\\?InvalidArgumentException'],
    },
    lint_php: true,
  },
  {
    id: 'topic-finder-test-coverage',
    family: 'test-addition-coverage',
    title: 'Add focused unit coverage for notification topic lookup without touching production code',
    task: {
      task_type: 'modify',
      target: 'unit tests for notification topic lookup',
      instructions: [
        'App\\NotificationSystem\\Service\\TopicFinder has no unit tests.',
        'Add a single PHPUnit test file at tests/NotificationSystem/Service/TopicFinderTest.php, following the existing plain-TestCase style used by tests like tests/ReportSystem/Service/ReportSystemCoordinatorTest.php, covering: getTopicByType returns the topic whose getType matches the requested TopicType; getTopicByType throws InvalidArgumentException when no topic matches; getCronScheduledTopics returns only CronScheduledTopic instances; getSubscribableTopics returns only SubscribableTopic instances.',
        'Keep every test double inside the test file and do not change any production source file or any other file.',
      ].join(' '),
      success_criteria: [
        'tests/NotificationSystem/Service/TopicFinderTest.php exists and covers matched lookup, not-found throw, cron-scheduled filtering, and subscribable filtering.',
        'No production source file changes.',
        'The test file is the only changed file.',
      ],
    },
    expected_files: [
      'src/NotificationSystem/Service/TopicFinder.php',
      'src/NotificationSystem/Model/Topic.php',
      'src/NotificationSystem/Model/CronScheduledTopic.php',
      'src/NotificationSystem/Model/SubscribableTopic.php',
    ],
    expected_terms: ['topic', 'finder', 'cron', 'subscribable', 'test'],
    changed_files: ['tests/NotificationSystem/Service/TopicFinderTest.php'],
    live_checks: [
      { file: 'tests/NotificationSystem/Service/TopicFinderTest.php', patterns: ['class TopicFinderTest', 'getTopicByType', 'CronScheduledTopic', 'SubscribableTopic', 'expectException'] },
    ],
    semantic_rules: {
      required_changed_files: ['tests/NotificationSystem/Service/TopicFinderTest.php'],
      forbidden_changed_files: ['src/NotificationSystem/Service/TopicFinder.php'],
      allow_only_changed_files: true,
      max_changed_files: 1,
      require_test_change: true,
      required_diff_patterns: [
        'TopicFinder',
        'expectException',
        'CronScheduledTopic',
        'SubscribableTopic',
      ],
    },
    lint_php: true,
  },
];

const SCENARIOS: SeededScenario[] = [
  {
    id: 'tenant-leak-diagnosis',
    family: 'bug-diagnosis-root-cause',
    title: 'Diagnose a tenant-scope leak before editing',
    task: {
      task_type: 'debug',
      target: 'workspace task visibility leak',
      instructions: 'Diagnose why users can see tasks from another workspace. Identify the root cause and the minimal files to inspect before editing.',
      success_criteria: [
        'Root cause points at repository filtering, not the controller alone.',
        'Tenant/workspace policy remains explicit.',
        'Focused tests target cross-workspace visibility.',
      ],
    },
    files: tenantTaskFiles({
      'src/repositories/taskRepository.ts': [
        'import type { Task } from "../domain/task";',
        'export class TaskRepository {',
        '  constructor(private readonly rows: Task[]) {}',
        '  listVisibleForUser(userId: string, workspaceId: string): Task[] {',
        '    void workspaceId;',
        '    return this.rows.filter(task => task.assigneeId === userId);',
        '  }',
        '}',
      ].join('\n'),
    }),
    expected_files: ['src/repositories/taskRepository.ts', 'src/policies/workspacePolicy.ts', 'tests/taskVisibility.test.ts'],
    expected_terms: ['workspace', 'tenant', 'repository', 'visibility', 'test'],
    changed_files: ['src/repositories/taskRepository.ts', 'tests/taskVisibility.test.ts'],
    diff_text: diff('src/repositories/taskRepository.ts', 'return this.rows.filter(task => task.assigneeId === userId);', 'return this.rows.filter(task => task.assigneeId === userId && task.workspaceId === workspaceId);'),
    live_checks: [
      { file: 'src/repositories/taskRepository.ts', patterns: ['workspaceId', 'task\\.workspaceId\\s*===\\s*workspaceId'], absent_patterns: ['void\\s+workspaceId'] },
      { file: 'tests/taskVisibility.test.ts', patterns: ['workspace|tenant|visibility|cross'] },
    ],
    semantic_rules: {
      required_changed_files: ['src/repositories/taskRepository.ts', 'tests/taskVisibility.test.ts'],
      max_changed_files: 3,
      required_diff_patterns: ['task\\.workspaceId\\s*===\\s*workspaceId', 'cross-workspace|workspace-b|tenant leak'],
      forbidden_diff_patterns: ['assertWorkspaceMember\\([^)]*workspace-b', 'skip\\(|todo\\('],
    },
  },
  {
    id: 'task-title-validation-fix',
    family: 'bug-fix-live-edits',
    title: 'Fix validation without bypassing local service boundaries',
    task: {
      task_type: 'modify',
      target: 'task title validation',
      instructions: 'Fix the bug that allows blank task titles while preserving the existing service/repository/policy boundaries.',
      success_criteria: [
        'Validation lives at the service boundary.',
        'Repository shape is unchanged.',
        'Focused tests cover blank titles.',
      ],
    },
    files: tenantTaskFiles({
      'src/services/taskService.ts': [
        'import { TaskRepository } from "../repositories/taskRepository";',
        'import { assertWorkspaceMember } from "../policies/workspacePolicy";',
        'export class TaskService {',
        '  constructor(private readonly repository: TaskRepository) {}',
        '  createTask(input: { workspaceId: string; title: string; assigneeId: string }) {',
        '    assertWorkspaceMember(input.workspaceId, input.assigneeId);',
        '    return this.repository.create(input);',
        '  }',
        '}',
      ].join('\n'),
    }),
    expected_files: ['src/services/taskService.ts', 'tests/taskService.test.js'],
    expected_terms: ['validation', 'service', 'blank', 'title', 'test'],
    changed_files: ['src/services/taskService.ts', 'tests/taskService.test.ts'],
    diff_text: diff('src/services/taskService.ts', 'assertWorkspaceMember(input.workspaceId, input.assigneeId);', 'if (!input.title.trim()) throw new Error("Task title is required");\n    assertWorkspaceMember(input.workspaceId, input.assigneeId);'),
    live_checks: [
      { file: 'src/services/taskService.ts', patterns: ['title\\.trim\\(\\)|trim\\(\\).*title|Task title is required'] },
      { file: 'tests/taskService.test.js', patterns: ['blank|empty|Task title|required|throws'] },
    ],
    semantic_rules: {
      required_changed_files: ['src/services/taskService.ts', 'tests/taskService.test.js'],
      max_changed_files: 3,
      required_diff_patterns: ['title\\.trim\\(\\)|trim\\(\\).*title|Task title is required', 'blank|empty|required|throws'],
      forbidden_diff_patterns: ['repository\\.create\\(\\{[^}]*title:\\s*input\\.title\\.trim\\(\\)', 'assert\\.ok\\(true\\)'],
    },
  },
  {
    id: 'controller-repository-refactor',
    family: 'architectural-change-refactor',
    title: 'Move direct data access behind the local service/repository boundary',
    task: {
      task_type: 'modify',
      target: 'direct task controller data access',
      instructions: 'Refactor the controller so it follows the existing service/repository architecture instead of reading the database directly.',
      success_criteria: [
        'Controller restores the local makeTaskController injection shape and delegates to TaskService.',
        'TaskRepository remains the data-access boundary.',
        'Route behavior is preserved.',
      ],
    },
    files: tenantTaskFiles({
      'src/controllers/taskController.ts': [
        'import { db } from "../db";',
        'export async function listTasks(req: { workspaceId: string; userId: string }) {',
        '  return db.tasks.filter(task => task.workspaceId === req.workspaceId && task.assigneeId === req.userId);',
        '}',
      ].join('\n'),
    }),
    expected_files: ['src/controllers/taskController.ts', 'src/services/taskService.ts', 'src/repositories/taskRepository.ts'],
    expected_terms: ['controller', 'service', 'repository', 'boundary', 'delegate', 'makeTaskController'],
    changed_files: ['src/controllers/taskController.ts', 'src/services/taskService.ts'],
    diff_text: diff('src/controllers/taskController.ts', 'return db.tasks.filter(task => task.workspaceId === req.workspaceId && task.assigneeId === req.userId);', 'return { listTasks: (req) => taskService.listVisibleForUser(req.userId, req.workspaceId) };'),
    live_checks: [
      { file: 'src/controllers/taskController.ts', patterns: ['TaskService|taskService', 'makeTaskController', 'listVisibleForUser'], absent_patterns: ['from "../db"|db\\.tasks'] },
      { file: 'src/services/taskService.ts', patterns: ['listVisibleForUser'] },
    ],
    semantic_rules: {
      required_changed_files: ['src/controllers/taskController.ts'],
      max_changed_files: 4,
      required_diff_patterns: ['TaskService|taskService', 'makeTaskController', 'listVisibleForUser'],
      forbidden_diff_patterns: ['from "../db"', 'db\\.tasks', 'new TaskRepository\\('],
    },
  },
  {
    id: 'n-plus-one-task-summary',
    family: 'performance-fixes',
    title: 'Fix an N+1 task summary path without changing contracts',
    task: {
      task_type: 'debug',
      target: 'task summary performance regression',
      instructions: 'Diagnose and fix the slow task summary path that loads each project one by one. Preserve the public summary contract.',
      success_criteria: [
        'Root cause identifies repeated repository calls.',
        'Fix batches project lookups behind the repository boundary.',
        'Tests preserve the summary contract.',
      ],
    },
    files: tenantTaskFiles({
      'src/services/taskSummaryService.ts': [
        'import { ProjectRepository } from "../repositories/projectRepository";',
        'import type { Task } from "../domain/task";',
        'export class TaskSummaryService {',
        '  constructor(private readonly projects: ProjectRepository) {}',
        '  async summarize(tasks: Task[]) {',
        '    return Promise.all(tasks.map(async task => ({',
        '      taskId: task.id,',
        '      project: await this.projects.findById(task.projectId),',
        '    })));',
        '  }',
        '}',
      ].join('\n'),
      'src/repositories/projectRepository.ts': [
        'export class ProjectRepository {',
        '  async findById(id: string) { return { id, name: id }; }',
        '  async findByIds(ids: string[]) { return ids.map(id => ({ id, name: id })); }',
        '}',
      ].join('\n'),
    }),
    expected_files: ['src/services/taskSummaryService.ts', 'src/repositories/projectRepository.ts', 'tests/taskSummaryService.test.ts'],
    expected_terms: ['performance', 'batch', 'repository', 'summary', 'test'],
    changed_files: ['src/services/taskSummaryService.ts', 'tests/taskSummaryService.test.ts'],
    diff_text: diff('src/services/taskSummaryService.ts', 'project: await this.projects.findById(task.projectId),', 'project: projectById.get(task.projectId),'),
    live_checks: [
      { file: 'src/services/taskSummaryService.ts', patterns: ['findByIds', 'Map|projectById'], absent_patterns: ['map\\(async task[\\s\\S]*findById'] },
      { file: 'tests/taskSummaryService.test.ts', patterns: ['batch|findByIds|summary|contract'] },
    ],
    semantic_rules: {
      required_changed_files: ['src/services/taskSummaryService.ts', 'tests/taskSummaryService.test.ts'],
      max_changed_files: 3,
      required_diff_patterns: ['findByIds', 'Map|projectById', 'batch|summary contract'],
      forbidden_diff_patterns: ['findById\\(task\\.projectId\\)', 'Promise\\.all\\(tasks\\.map\\(async task'],
    },
  },
  {
    id: 'producer-consumer-contract-change',
    family: 'cross-repo-contract-changes',
    title: 'Change a producer/consumer task contract without orphaning clients',
    task: {
      task_type: 'modify',
      target: 'task due date contract',
      instructions: 'Add due-date timezone support to the task contract and update every downstream producer/consumer boundary together. Keep the API serializer responsible for defaulting missing legacy timezone values, keep web rendering local to the client adapter, keep export formatting local to the worker, and add contract tests that prove all three boundaries agree.',
      success_criteria: [
        'Producer DTO includes dueDateTimezone.',
        'API serializer defaults legacy tasks to UTC without pushing defaulting into consumers.',
        'Consumer client reads dueDateTimezone.',
        'Export worker includes dueDateTimezone in its row shape.',
        'Contract tests cover the new field.',
      ],
    },
    files: {
      'package.json': '{"scripts":{"test":"node tests/contract.test.js"},"type":"module"}',
      'packages/api/src/contracts/taskContract.ts': 'export interface TaskDto { id: string; title: string; dueDate: string; }',
      'packages/api/src/routes/taskRoutes.ts': 'import type { TaskDto } from "../contracts/taskContract"; export function serializeTask(task: TaskDto) { return task; }',
      'packages/web/src/client/taskClient.ts': 'import type { TaskDto } from "../../../api/src/contracts/taskContract"; export function renderDueDate(task: TaskDto) { return task.dueDate; }',
      'packages/worker/src/export/taskExport.ts': 'import type { TaskDto } from "../../../api/src/contracts/taskContract"; export function taskExportRow(task: TaskDto) { return { id: task.id, dueDate: task.dueDate }; }',
      'tests/contract.test.js': 'import assert from "node:assert/strict"; assert.ok(true);',
    },
    expected_files: ['packages/api/src/contracts/taskContract.ts', 'packages/api/src/routes/taskRoutes.ts', 'packages/web/src/client/taskClient.ts', 'packages/worker/src/export/taskExport.ts', 'tests/contract.test.js'],
    expected_terms: ['contract', 'producer', 'consumer', 'serializer', 'export', 'client', 'test'],
    changed_files: ['packages/api/src/contracts/taskContract.ts', 'packages/api/src/routes/taskRoutes.ts', 'packages/web/src/client/taskClient.ts', 'packages/worker/src/export/taskExport.ts', 'tests/contract.test.js'],
    diff_text: diff('packages/api/src/contracts/taskContract.ts', 'dueDate: string;', 'dueDate: string;\n  dueDateTimezone: string;'),
    live_checks: [
      { file: 'packages/api/src/contracts/taskContract.ts', patterns: ['dueDateTimezone'] },
      { file: 'packages/api/src/routes/taskRoutes.ts', patterns: ['dueDateTimezone', 'UTC'] },
      { file: 'packages/web/src/client/taskClient.ts', patterns: ['dueDateTimezone'] },
      { file: 'packages/worker/src/export/taskExport.ts', patterns: ['dueDateTimezone'] },
      { file: 'tests/contract.test.js', patterns: ['dueDateTimezone', 'serializeTask', 'renderDueDate', 'taskExportRow'] },
    ],
    semantic_rules: {
      required_changed_files: ['packages/api/src/contracts/taskContract.ts', 'packages/api/src/routes/taskRoutes.ts', 'packages/web/src/client/taskClient.ts', 'packages/worker/src/export/taskExport.ts', 'tests/contract.test.js'],
      max_changed_files: 5,
      required_diff_patterns: ['dueDateTimezone', 'serializeTask', 'UTC', 'renderDueDate|taskClient|consumer', 'taskExportRow|export', 'contract'],
      forbidden_diff_patterns: ['any', 'as unknown as TaskDto'],
    },
  },
  {
    id: 'task-label-product-enhancement',
    family: 'real-product-enhancements',
    title: 'Add task label colors without rebuilding task ownership',
    task: {
      task_type: 'modify',
      target: 'task label color enhancement',
      instructions: 'Add support for task label colors by extending the existing task model, service, repository, controller, and focused tests. Do not create a parallel label subsystem.',
      success_criteria: [
        'Task labels are owned by the existing task domain model.',
        'TaskService exposes the enhancement instead of bypassing local boundaries.',
        'Focused tests cover colored labels.',
      ],
    },
    files: tenantTaskFiles({
      'src/domain/taskLabel.ts': [
        'export interface TaskLabel {',
        '  id: string;',
        '  workspaceId: string;',
        '  taskId: string;',
        '  name: string;',
        '}',
      ].join('\n'),
      'src/services/taskLabelService.ts': [
        'import type { TaskLabel } from "../domain/taskLabel";',
        'export class TaskLabelService {',
        '  assignLabel(label: TaskLabel) {',
        '    return label;',
        '  }',
        '}',
      ].join('\n'),
    }),
    expected_files: ['src/domain/taskLabel.ts', 'src/services/taskLabelService.ts', 'tests/taskService.test.js'],
    expected_terms: ['label', 'color', 'service', 'task', 'test'],
    changed_files: ['src/domain/taskLabel.ts', 'src/services/taskLabelService.ts', 'tests/taskService.test.js'],
    diff_text: diff('src/domain/taskLabel.ts', 'name: string;', 'name: string;\n  color: string;'),
    live_checks: [
      { file: 'src/domain/taskLabel.ts', patterns: ['color'] },
      { file: 'src/services/taskLabelService.ts', patterns: ['color', 'assignLabel'] },
      { file: 'tests/taskService.test.js', patterns: ['label|color|colored'] },
    ],
    semantic_rules: {
      required_changed_files: ['src/domain/taskLabel.ts', 'src/services/taskLabelService.ts', 'tests/taskService.test.js'],
      forbidden_changed_files: ['src/domain/label.ts', 'src/services/labelService.ts'],
      max_changed_files: 4,
      required_diff_patterns: ['color', 'assignLabel', 'label.*color|colored label'],
      forbidden_diff_patterns: ['class LabelService', 'interface Label \\{'],
    },
  },
  {
    id: 'task-due-date-migration',
    family: 'schema-migration-changes',
    title: 'Add task due-date persistence through a migration',
    task: {
      task_type: 'modify',
      target: 'task due date migration',
      instructions: 'Add persisted task due dates using the existing task model and repository. Create a migration file instead of editing schema ad hoc.',
      success_criteria: [
        'Task model includes dueAt.',
        'Repository persists dueAt through the existing task boundary.',
        'A migration adds the due_at column and index.',
      ],
    },
    files: tenantTaskFiles({
      'migrations/001_create_tasks.sql': [
        'create table tasks (',
        '  id text primary key,',
        '  workspace_id text not null,',
        '  project_id text not null,',
        '  title text not null,',
        '  assignee_id text not null',
        ');',
      ].join('\n'),
    }),
    expected_files: ['src/domain/task.ts', 'src/repositories/taskRepository.ts', 'migrations/001_create_tasks.sql', 'tests/taskService.test.js'],
    expected_terms: ['migration', 'due', 'repository', 'task', 'test'],
    changed_files: ['src/domain/task.ts', 'src/repositories/taskRepository.ts', 'migrations/002_add_task_due_at.sql', 'tests/taskService.test.js'],
    diff_text: diff('src/domain/task.ts', 'title: string;', 'title: string;\n  dueAt?: string;'),
    live_checks: [
      { file: 'src/domain/task.ts', patterns: ['dueAt'] },
      { file: 'src/repositories/taskRepository.ts', patterns: ['dueAt'] },
      { file: 'migrations/002_add_task_due_at.sql', patterns: ['due_at|dueAt', 'alter table|create index'] },
    ],
    semantic_rules: {
      required_changed_files: ['src/domain/task.ts', 'src/repositories/taskRepository.ts', 'migrations/002_add_task_due_at.sql'],
      forbidden_changed_files: ['migrations/001_create_tasks.sql'],
      max_changed_files: 5,
      required_diff_patterns: ['dueAt', 'due_at', 'alter table|create index'],
      forbidden_diff_patterns: ['drop table', 'delete from tasks'],
    },
  },
  {
    id: 'workspace-role-policy-hardening',
    family: 'auth-tenant-boundary-changes',
    title: 'Require workspace roles before task assignment',
    task: {
      task_type: 'modify',
      target: 'workspace role authorization for task assignment',
      instructions: 'Harden task assignment so only workspace admins or project managers can assign tasks. Preserve the existing workspace policy boundary.',
      success_criteria: [
        'Authorization stays in workspacePolicy.',
        'TaskService calls the policy before assignment.',
        'Focused tests cover unauthorized assignment.',
      ],
    },
    files: tenantTaskFiles({
      'src/services/taskService.ts': [
        'import { TaskRepository } from "../repositories/taskRepository";',
        'import { assertWorkspaceMember } from "../policies/workspacePolicy";',
        'export class TaskService {',
        '  constructor(private readonly repository: TaskRepository) {}',
        '  assignTask(input: { workspaceId: string; actorUserId: string; assigneeId: string; taskId: string }) {',
        '    assertWorkspaceMember(input.workspaceId, input.actorUserId);',
        '    return this.repository.assign(input.taskId, input.assigneeId);',
        '  }',
        '}',
      ].join('\n'),
      'src/repositories/taskRepository.ts': [
        'import type { Task } from "../domain/task";',
        'export class TaskRepository {',
        '  assign(taskId: string, assigneeId: string): Task {',
        '    return { id: taskId, workspaceId: "workspace-1", projectId: "project-1", title: "Task", assigneeId };',
        '  }',
        '}',
      ].join('\n'),
    }),
    expected_files: ['src/policies/workspacePolicy.ts', 'src/services/taskService.ts', 'tests/taskService.test.js'],
    expected_terms: ['role', 'authorization', 'workspace', 'policy', 'test'],
    changed_files: ['src/policies/workspacePolicy.ts', 'src/services/taskService.ts', 'tests/taskService.test.js'],
    diff_text: diff('src/policies/workspacePolicy.ts', '}', '}\nexport function assertCanAssignTask(role: string) { if (!["admin", "project_manager"].includes(role)) throw new Error("Not authorized"); }'),
    live_checks: [
      { file: 'src/policies/workspacePolicy.ts', patterns: ['assertCanAssign|admin|project_manager|role'] },
      { file: 'src/services/taskService.ts', patterns: ['assertCanAssign|role|policy'] },
      { file: 'tests/taskService.test.js', patterns: ['unauthorized|not authorized|role|assign'] },
    ],
    semantic_rules: {
      required_changed_files: ['src/policies/workspacePolicy.ts', 'src/services/taskService.ts', 'tests/taskService.test.js'],
      max_changed_files: 4,
      required_diff_patterns: ['assertCanAssign|canAssign', 'admin|project_manager', 'unauthorized|Not authorized|not authorized'],
      forbidden_diff_patterns: ['role\\s*===\\s*"user"', 'return true'],
    },
  },
  {
    id: 'password-auth-to-oidc-replacement',
    family: 'auth-system-replacement',
    title: 'Replace password auth with OIDC without bypassing session boundaries',
    task: {
      task_type: 'modify',
      target: 'replace password auth with OIDC',
      instructions: 'Replace the local password-checking login flow with an OIDC-backed flow. Preserve AuthService as the application boundary, keep SessionRepository as the session persistence boundary, and update focused auth tests.',
      success_criteria: [
        'AuthService delegates identity verification to OidcClient instead of checking passwords directly.',
        'SessionRepository remains the only session persistence boundary.',
        'Tests prove external identity, session creation, and rejected invalid identity.',
      ],
    },
    files: authSystemFiles({
      'src/auth/authService.ts': [
        'import { SessionRepository } from "./sessionRepository";',
        'import { PasswordHasher } from "./passwordHasher";',
        'export class AuthService {',
        '  constructor(private readonly sessions: SessionRepository, private readonly passwords: PasswordHasher) {}',
        '  async login(input: { email: string; password: string }) {',
        '    const user = await this.passwords.verify(input.email, input.password);',
        '    if (!user) throw new Error("Invalid credentials");',
        '    return this.sessions.createSession(user.id);',
        '  }',
        '}',
      ].join('\n'),
      'src/auth/passwordHasher.ts': 'export class PasswordHasher { async verify(email: string, password: string) { return password ? { id: email } : null; } }',
      'src/auth/oidcClient.ts': 'export class OidcClient { async verifyIdToken(idToken: string) { return idToken ? { subject: idToken } : null; } }',
    }),
    expected_files: ['src/auth/authService.ts', 'src/auth/oidcClient.ts', 'src/auth/sessionRepository.ts', 'tests/authService.test.js'],
    expected_terms: ['oidc', 'auth', 'session', 'boundary', 'test'],
    changed_files: ['src/auth/authService.ts', 'tests/authService.test.js'],
    diff_text: diff('src/auth/authService.ts', 'const user = await this.passwords.verify(input.email, input.password);', 'const identity = await this.oidc.verifyIdToken(input.idToken);'),
    live_checks: [
      { file: 'src/auth/authService.ts', patterns: ['OidcClient|oidc', 'verifyIdToken', 'createSession'], absent_patterns: ['PasswordHasher|passwords\\.verify'] },
      { file: 'tests/authService.test.js', patterns: ['OIDC|id token|verifyIdToken|session|invalid'] },
    ],
    semantic_rules: {
      required_changed_files: ['src/auth/authService.ts', 'tests/authService.test.js'],
      forbidden_changed_files: ['src/auth/sessionRepository.ts'],
      max_changed_files: 4,
      required_diff_patterns: ['OidcClient|oidc', 'verifyIdToken', 'createSession', 'invalid|reject'],
      forbidden_diff_patterns: ['passwords\\.verify', 'new SessionRepository\\(', 'localStorage|cookie\\s*='],
    },
  },
  {
    id: 'step-up-mfa-login',
    family: 'mfa-security-enhancement',
    title: 'Add step-up MFA without turning auth into inline controller logic',
    task: {
      task_type: 'modify',
      target: 'step-up MFA login',
      instructions: 'Add MFA challenge enforcement to login. Keep MFA decisions in MfaService, keep sessions in SessionRepository, and update tests for challenged, verified, and failed MFA paths.',
      success_criteria: [
        'AuthService asks MfaService whether a challenge is required.',
        'MfaService owns challenge creation and TOTP/challenge verification.',
        'Session creation happens only after MFA is satisfied.',
      ],
    },
    files: authSystemFiles({
      'src/auth/mfaService.ts': [
        'export class MfaService {',
        '  isRequired(userId: string) { return userId.startsWith("admin"); }',
        '  verifyTotp(userId: string, code: string) { return Boolean(userId && code === "123456"); }',
        '}',
      ].join('\n'),
    }),
    expected_files: ['src/auth/authService.ts', 'src/auth/mfaService.ts', 'src/auth/sessionRepository.ts', 'tests/authService.test.js'],
    expected_terms: ['mfa', 'challenge', 'session', 'auth', 'test', 'createChallenge', 'verifyChallenge'],
    changed_files: ['src/auth/authService.ts', 'src/auth/mfaService.ts', 'tests/authService.test.js'],
    diff_text: diff('src/auth/authService.ts', 'return this.sessions.createSession(user.id);', 'if (this.mfa.isRequired(user.id) && !this.mfa.verifyTotp(user.id, input.mfaCode)) return { challenge: "mfa_required" };\n    return this.sessions.createSession(user.id);'),
    live_checks: [
      { file: 'src/auth/authService.ts', patterns: ['MfaService|mfa', 'challenge|mfa_required', 'createSession'] },
      { file: 'src/auth/mfaService.ts', patterns: ['createChallenge|challenge', 'verifyChallenge|verifyTotp', 'isRequired'] },
      { file: 'tests/authService.test.js', patterns: ['mfa|challenge|totp|session'] },
    ],
    semantic_rules: {
      required_changed_files: ['src/auth/authService.ts', 'src/auth/mfaService.ts', 'tests/authService.test.js'],
      max_changed_files: 4,
      required_diff_patterns: ['MfaService|mfa', 'createChallenge|challenge', 'verifyChallenge|verifyTotp', 'createSession'],
      forbidden_diff_patterns: ['code\\s*===\\s*"000000"', 'return this\\.sessions\\.createSession\\([^)]*\\)[\\s\\S]*verifyTotp', 'challenge:\\s*\\{'],
    },
  },
  {
    id: 'distributed-auth-oidc-replacement',
    family: 'auth-system-replacement',
    title: 'Replace distributed password auth with OIDC across application boundaries',
    task: {
      task_type: 'modify',
      target: 'distributed OIDC auth replacement',
      instructions: [
        'Replace the password-based login path with OIDC across the auth service, auth module wiring, API controller, and focused tests.',
        'Preserve AuthService as the application boundary, SessionRepository as the only session persistence boundary, and AuditLogger as the audit boundary.',
        'Do not move session creation into controllers or rewrite the session repository.',
      ].join(' '),
      success_criteria: [
        'AuthService verifies identity with OidcClient and still creates sessions through SessionRepository.',
        'AuthModule wires OidcClient instead of the password verifier.',
        'SessionController accepts an OIDC token shape without creating sessions directly.',
        'Focused tests cover successful OIDC login, rejected invalid identity, and audit/session behavior.',
      ],
    },
    files: distributedAuthFiles(),
    expected_files: [
      'src/auth/authService.ts',
      'src/auth/authModule.ts',
      'src/api/sessionController.ts',
      'src/auth/oidcClient.ts',
      'src/auth/sessionRepository.ts',
      'src/audit/auditLogger.ts',
      'tests/authService.test.js',
    ],
    expected_terms: ['oidc', 'session', 'controller', 'module', 'audit', 'boundary', 'test'],
    changed_files: ['src/auth/authService.ts', 'src/auth/authModule.ts', 'src/api/sessionController.ts', 'tests/authService.test.js'],
    diff_text: diff('src/auth/authService.ts', 'const user = await this.passwords.verify(input.email, input.password);', 'const identity = await this.oidc.verifyIdToken(input.idToken);'),
    live_checks: [
      { file: 'src/auth/authService.ts', patterns: ['OidcClient|oidc', 'verifyIdToken', 'createSession', 'audit\\.record'], absent_patterns: ['PasswordCredentialVerifier|passwords\\.verify'] },
      { file: 'src/auth/authModule.ts', patterns: ['OidcClient', 'AuthService', 'SessionRepository'], absent_patterns: ['PasswordCredentialVerifier'] },
      { file: 'src/api/sessionController.ts', patterns: ['idToken', 'auth\\.login'], absent_patterns: ['createSession|SessionRepository|PasswordCredentialVerifier'] },
      { file: 'tests/authService.test.js', patterns: ['OIDC|id token|verifyIdToken|session|audit|invalid'] },
    ],
    semantic_rules: {
      required_changed_files: ['src/auth/authService.ts', 'src/auth/authModule.ts', 'src/api/sessionController.ts', 'tests/authService.test.js'],
      forbidden_changed_files: ['src/auth/sessionRepository.ts', 'src/audit/auditLogger.ts', 'src/auth/passwordCredentialVerifier.ts'],
      max_changed_files: 5,
      required_diff_patterns: [
        'OidcClient|oidc',
        'verifyIdToken',
        'idToken',
        'audit\\.record|record\\(',
        'invalid|reject',
      ],
      forbidden_diff_patterns: [
        'passwords\\.verify',
        'localStorage|cookie\\s*=',
      ],
    },
  },
  {
    id: 'split-task-monolith',
    family: 'monolith-decomposition',
    title: 'Break up a task monolith into local controller/service/repository boundaries',
    task: {
      task_type: 'modify',
      target: 'task monolith decomposition',
      instructions: 'Split the task monolith so routing stays in the controller, business rules move to TaskService, and persistence moves to TaskRepository. Preserve behavior and add focused coverage for the extracted service boundary.',
      success_criteria: [
        'TaskController no longer owns direct data filtering and mutation.',
        'TaskService owns workspace membership and workflow rules.',
        'TaskRepository owns rows/persistence access.',
      ],
    },
    files: monolithTaskFiles(),
    expected_files: ['src/taskModule.ts', 'src/controllers/taskController.ts', 'src/services/taskService.ts', 'src/repositories/taskRepository.ts', 'tests/taskService.test.js'],
    expected_terms: ['monolith', 'controller', 'service', 'repository', 'test'],
    changed_files: ['src/taskModule.ts', 'src/controllers/taskController.ts', 'src/services/taskService.ts', 'src/repositories/taskRepository.ts', 'tests/taskService.test.js'],
    diff_text: diff('src/taskModule.ts', 'export function listTasks(req: RequestContext) {', 'export { makeTaskController } from "./controllers/taskController";'),
    live_checks: [
      { file: 'src/controllers/taskController.ts', patterns: ['TaskService|taskService', 'listTasks|createTask'], absent_patterns: ['rows\\.filter|rows\\.push'] },
      { file: 'src/services/taskService.ts', patterns: ['assertWorkspaceMember|workspace', 'TaskRepository|repository'] },
      { file: 'src/repositories/taskRepository.ts', patterns: ['listVisibleForUser|create', 'rows'] },
      { file: 'tests/taskService.test.js', patterns: ['TaskService|workspace|create|list'] },
    ],
    semantic_rules: {
      required_changed_files: ['src/controllers/taskController.ts', 'src/services/taskService.ts', 'src/repositories/taskRepository.ts', 'tests/taskService.test.js'],
      max_changed_files: 6,
      required_diff_patterns: ['TaskService|taskService', 'TaskRepository|repository', 'assertWorkspaceMember|workspace', 'listVisibleForUser|listTasks'],
      forbidden_diff_patterns: ['controllers/taskController[\\s\\S]*rows\\.push', 'controllers/taskController[\\s\\S]*rows\\.filter'],
    },
  },
  {
    id: 'audit-log-feature-integration',
    family: 'large-feature-integration',
    title: 'Add audit logging as a cross-cutting feature without duplicating workflows',
    task: {
      task_type: 'modify',
      target: 'task audit log feature',
      instructions: 'Add audit logging for task creation and assignment. Use the existing TaskService workflow as the write point, add an AuditLogRepository boundary, and add tests that prove the audit event records actor, workspace, action, and task.',
      success_criteria: [
        'TaskService emits audit events from existing workflows.',
        'AuditLogRepository is the persistence boundary for audit records.',
        'Tests cover create and assign audit records with workspace and actor context.',
      ],
    },
    files: tenantTaskFiles({
      'src/repositories/auditLogRepository.ts': [
        'export interface AuditEvent { workspaceId: string; actorUserId: string; action: string; entityId: string; }',
        'export class AuditLogRepository {',
        '  private readonly events: AuditEvent[] = [];',
        '  record(event: AuditEvent) { this.events.push(event); return event; }',
        '  all() { return this.events; }',
        '}',
      ].join('\n'),
    }),
    expected_files: ['src/services/taskService.ts', 'src/repositories/auditLogRepository.ts', 'tests/taskService.test.js'],
    expected_terms: ['audit', 'event', 'workflow', 'service', 'test'],
    changed_files: ['src/services/taskService.ts', 'src/repositories/auditLogRepository.ts', 'tests/taskService.test.js'],
    diff_text: diff('src/services/taskService.ts', 'return this.repository.create(input);', 'const task = this.repository.create(input);\n    this.audit.record({ workspaceId: input.workspaceId, actorUserId: input.assigneeId, action: "task.created", entityId: task.id });\n    return task;'),
    live_checks: [
      { file: 'src/services/taskService.ts', patterns: ['AuditLogRepository|audit', 'task\\.created|task\\.assigned', 'actorUserId|workspaceId'] },
      { file: 'src/repositories/auditLogRepository.ts', patterns: ['AuditEvent', 'record', 'workspaceId', 'actorUserId'] },
      { file: 'tests/taskService.test.js', patterns: ['audit|task\\.created|task\\.assigned|actor'] },
    ],
    semantic_rules: {
      required_changed_files: ['src/services/taskService.ts', 'src/repositories/auditLogRepository.ts', 'tests/taskService.test.js'],
      forbidden_changed_files: ['src/controllers/taskController.ts'],
      max_changed_files: 5,
      required_diff_patterns: ['AuditLogRepository|audit', 'task\\.created|task\\.assigned', 'actorUserId', 'workspaceId'],
      forbidden_diff_patterns: ['console\\.log\\(.*audit', 'class TaskAuditService'],
    },
  },
  {
    id: 'missing-coverage-task-archive',
    family: 'test-addition-coverage',
    title: 'Add missing archive behavior coverage without changing production code',
    task: {
      task_type: 'modify',
      target: 'missing archive behavior tests',
      instructions: 'Add focused tests for existing task archive behavior. Do not change production code unless the tests reveal a real defect.',
      success_criteria: [
        'Tests target TaskService archive behavior.',
        'Existing service/repository boundaries are not bypassed.',
        'Production source remains unchanged unless the test exposes a defect.',
      ],
    },
    files: tenantTaskFiles({
      'src/services/taskService.ts': [
        'import { TaskRepository } from "../repositories/taskRepository";',
        'import { assertWorkspaceMember } from "../policies/workspacePolicy";',
        'export class TaskService {',
        '  constructor(private readonly repository: TaskRepository) {}',
        '  archiveTask(input: { workspaceId: string; actorUserId: string; taskId: string }) {',
        '    assertWorkspaceMember(input.workspaceId, input.actorUserId);',
        '    return this.repository.archive(input.taskId);',
        '  }',
        '}',
      ].join('\n'),
      'src/repositories/taskRepository.ts': [
        'import type { Task } from "../domain/task";',
        'export class TaskRepository {',
        '  archive(taskId: string): Task {',
        '    return { id: taskId, workspaceId: "workspace-1", projectId: "project-1", title: "Archived", assigneeId: "user-1" };',
        '  }',
        '}',
      ].join('\n'),
    }),
    expected_files: ['src/services/taskService.ts', 'src/repositories/taskRepository.ts', 'tests/taskService.test.js'],
    expected_terms: ['archive', 'test', 'service', 'repository', 'coverage'],
    changed_files: ['tests/taskService.test.js'],
    diff_text: diff('tests/taskService.test.js', 'assert.ok(true);', 'assert.ok(true);\nassert.ok("archive behavior is covered");'),
    live_checks: [
      { file: 'tests/taskService.test.js', patterns: ['archive|archived', 'TaskService|archiveTask'] },
    ],
    semantic_rules: {
      required_changed_files: ['tests/taskService.test.js'],
      forbidden_changed_files: ['src/services/taskService.ts', 'src/repositories/taskRepository.ts', 'src/domain/task.ts'],
      max_changed_files: 1,
      required_diff_patterns: ['archive|archived', 'TaskService|archiveTask'],
      require_test_change: true,
      require_production_change: false,
      allow_only_changed_files: true,
    },
  },
];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.realRepoPath) {
    const report = await runRealRepoExistingTaskBenchmark(args);
    printRealRepoReport(report);
    if (args.reportPath) {
      await fs.ensureDir(path.dirname(args.reportPath));
      await fs.writeJson(args.reportPath, report, { spaces: 2 });
    }
    if (args.markdownPath) {
      await fs.ensureDir(path.dirname(args.markdownPath));
      await fs.writeFile(args.markdownPath, formatRealRepoExistingTaskBenchmarkMarkdown(report));
    }
    await saveAgenticBenchmarkReport(report);
    if (report.status === 'fail') process.exitCode = 1;
    return;
  }
  const report = await runSeededExistingTaskBenchmark(args);
  printReport(report);
  if (args.reportPath) {
    await fs.ensureDir(path.dirname(args.reportPath));
    await fs.writeJson(args.reportPath, report, { spaces: 2 });
  }
  if (args.markdownPath) {
    await fs.ensureDir(path.dirname(args.markdownPath));
    await fs.writeFile(args.markdownPath, formatSeededExistingTaskBenchmarkMarkdown(report));
  }
  await saveAgenticBenchmarkReport(report);
  if (report.status === 'fail') process.exitCode = 1;
}

export async function runSeededExistingTaskBenchmark(args: Args = parseArgs([])): Promise<BenchmarkReport> {
  await fs.ensureDir(args.outputRoot);
  const scenarios: ScenarioResult[] = [];
  let liveTasksStarted = 0;
  for (const scenario of SCENARIOS) {
    const result = await runScenario(args.outputRoot, scenario);
    if (args.live && shouldRunLiveScenario(args.liveConfig, scenario, liveTasksStarted)) {
      result.live_pair = await runLiveExistingScenario(args.outputRoot, scenario, result, args.liveConfig, args.withoutArmRetrieval);
      result.live_summary = summarizeLivePair(result.live_pair);
      liveTasksStarted += 1;
    }
    scenarios.push(result);
  }
  const families = summarizeFamilies(scenarios);
  const score = Math.round(average(scenarios.map(scenario => scenario.score)));
  const status = score >= 90 ? 'pass' : score >= 70 ? 'warn' : 'fail';
  const liveSummaries = scenarios.map(scenario => scenario.live_summary).filter((summary): summary is NonNullable<ScenarioResult['live_summary']> => Boolean(summary));
  const proofStrength = liveSummaries.length > 0 ? 'live-agent-proof' : 'deterministic-proxy';
  return {
    generated_at: new Date().toISOString(),
    benchmark_type: 'seeded-existing-project-task-proof',
    status,
    score,
    summary: {
      proof_strength: proofStrength,
      claim_limit: proofStrength === 'live-agent-proof'
        ? 'Includes copied-repo live agent trials; quality/token claims may cite live deltas for covered families.'
        : 'Deterministic proxy only; proves packet targeting, token/file reduction, and expected guidance coverage, but not final live-agent quality.',
      scenario_count: scenarios.length,
      family_count: Object.keys(families).length,
      passing_scenarios: scenarios.filter(scenario => scenario.status === 'pass').length,
      average_score_delta: Math.round(average(scenarios.map(scenario => scenario.deltas.score_delta))),
      average_file_reduction_percentage: Math.round(average(scenarios.map(scenario => scenario.deltas.file_reduction_percentage))),
      average_token_reduction_percentage: Math.round(average(scenarios.map(scenario => scenario.deltas.token_reduction_percentage))),
      live_scenarios: liveSummaries.length,
      live_passing_scenarios: liveSummaries.filter(summary => summary.status === 'pass').length,
      average_live_quality_delta: Math.round(average(liveSummaries.map(summary => summary.quality_delta))),
      average_live_token_reduction_percentage: Math.round(average(liveSummaries.map(summary => summary.token_reduction_percentage ?? 0))),
      average_index_retrieval_file_recall: Math.round(average(scenarios.map(scenario => scenario.index_retrieval_baseline.file_recall))),
      average_index_retrieval_tokens: Math.round(average(scenarios.map(scenario => scenario.index_retrieval_baseline.estimated_tokens))),
      klauro_vs_index_retrieval_token_reduction_percentage: Math.round(average(scenarios.map(scenario =>
        percentReduction(scenario.index_retrieval_baseline.estimated_tokens, scenario.with_klauro.packet_tokens)))),
      families,
    },
    scenarios,
  };
}

function shouldRunLiveScenario(config: LiveAgentCommandConfig, scenario: SeededScenario, liveTasksStarted: number): boolean {
  if (!config.withKlauro || !config.withoutKlauro) {
    throw new Error('Live existing-task benchmark requires --agent-with-cmd and --agent-without-cmd');
  }
  if (typeof config.maxLiveTasks === 'number' && liveTasksStarted >= config.maxLiveTasks) return false;
  const taskTypes = config.liveTaskTypes || [];
  const taskCategories = config.liveTaskCategories || [];
  const typeMatches = taskTypes.length === 0 || taskTypes.includes(scenario.task.task_type);
  const categoryMatches = taskCategories.length === 0 || taskCategories.includes(scenario.family) || taskCategories.includes(scenario.id);
  return typeMatches && categoryMatches;
}

async function runLiveExistingScenario(outputRoot: string, scenario: SeededScenario, result: ScenarioResult, config: LiveAgentCommandConfig, withoutArmRetrieval = false): Promise<LiveAgentPairResult> {
  const validatorPath = await writeLiveValidator(outputRoot, scenario);
  return runLiveAgentPair({
    withoutArmRetrievedFiles: withoutArmRetrieval ? result.index_retrieval_baseline.retrieved_files : undefined,
    repo: scenario.id,
    repoPath: result.repo_path,
    taskId: scenario.id,
    taskLabel: scenario.title,
    taskCategory: scenario.family,
    task: {
      ...scenario.task,
      related_paths: scenario.expected_files,
    } as any,
    expectedOutcome: scenario.task.success_criteria.join(' '),
    fileReadPlan: result.with_klauro.first_files.map(file => ({
      file,
      reason: 'Klauro selected this file from the existing-codebase work packet.',
    })),
    validationPlan: {
      commands: [{ command: `node ${shellQuote(validatorPath)}` }],
      expected_changed_files: scenario.changed_files,
      semantic_rules: scenario.semantic_rules,
    },
    idiomContext: {
      task_family: scenario.family,
      expected_files: scenario.expected_files,
      changed_files: scenario.changed_files,
      semantic_rules: scenario.semantic_rules,
      guidance: [
        'Preserve the existing service/repository/controller boundaries.',
        'Put behavior at the existing owner boundary instead of duplicating a parallel model or service.',
        ...(scenario.semantic_rules.require_test_change === true
          ? ['Add or update the focused test named by the task.']
          : []),
      ],
    },
  }, {
    ...config,
    workRoot: outputRoot,
    testCommand: `node ${shellQuote(validatorPath)}`,
  });
}

export async function runRealRepoExistingTaskBenchmark(args: Args): Promise<RealRepoBenchmarkReport> {
  const repoPath = path.resolve(args.realRepoPath!);
  if (!(await fs.pathExists(repoPath))) throw new Error(`Real repo path does not exist: ${repoPath}`);
  const scenario = REAL_REPO_SCENARIOS.find(item => item.id === (args.realTaskId || REAL_REPO_SCENARIOS[0].id));
  if (!scenario) throw new Error(`Unknown real-repo task ${args.realTaskId}. Known tasks: ${REAL_REPO_SCENARIOS.map(item => item.id).join(', ')}`);
  if (!args.live || !args.liveConfig.withKlauro || !args.liveConfig.withoutKlauro) {
    throw new Error('Real-repo existing-task benchmark requires --live, --agent-with-cmd, and --agent-without-cmd');
  }
  await fs.ensureDir(args.outputRoot);

  const analysis = await analyzeProjectIncremental(repoPath);
  const cas = analysis.output;
  const packet = await getAgentWorkPacket(cas, repoPath, scenario.task as any) as any;
  const packetTokens = estimateTokens(JSON.stringify(packet));
  const fileReadPlan = Array.isArray(packet.file_read_plan) ? packet.file_read_plan : [];
  const firstFiles = fileReadPlan
    .map((item: any) => String(item.file || item.path || '')).filter(Boolean) as string[];

  const indexRetrieval = indexRetrievalBaselineScore(repoPath, scenario);
  const validatorPath = await writeLiveValidator(args.outputRoot, scenario);

  const pair = await runLiveAgentPair({
    repo: path.basename(repoPath),
    repoPath,
    taskId: scenario.id,
    taskLabel: scenario.title,
    taskCategory: scenario.family,
    task: {
      ...scenario.task,
      related_paths: scenario.changed_files,
    } as any,
    expectedOutcome: scenario.task.success_criteria.join(' '),
    fileReadPlan,
    idiomContext: { task_family: scenario.family },
    withoutArmRetrievedFiles: args.withoutArmRetrieval ? indexRetrieval.retrieved_files : undefined,
  }, {
    ...args.liveConfig,
    workRoot: args.outputRoot,
    testCommand: `node ${shellQuote(validatorPath)}`,
  });

  const liveSummary = summarizeLivePair(pair);
  return {
    generated_at: new Date().toISOString(),
    benchmark_type: 'real-repo-existing-task-live-ab',
    status: liveSummary.status,
    repo: path.basename(repoPath),
    repo_path: repoPath,
    scenario_id: scenario.id,
    scenario_title: scenario.title,
    family: scenario.family,
    without_arm_retrieval: args.withoutArmRetrieval,
    with_klauro: {
      packet_tokens: packetTokens,
      first_files: firstFiles.slice(0, 12),
    },
    index_retrieval_baseline: indexRetrieval,
    live_summary: liveSummary,
    live_pair: pair,
  };
}

export function formatRealRepoExistingTaskBenchmarkMarkdown(report: RealRepoBenchmarkReport): string {
  const withArm = report.live_pair.with_klauro;
  const withoutArm = report.live_pair.without_klauro;
  return [
    '# Real-Repo Existing-Task Live A/B',
    '',
    `Generated: ${report.generated_at}`,
    `Repo: ${report.repo} (${report.repo_path})`,
    `Task: ${report.scenario_title} (${report.scenario_id}, ${report.family})`,
    `Without-arm context: ${report.without_arm_retrieval ? 'index-retrieval candidates injected (Cursor-style baseline)' : 'no precomputed context'}`,
    `Status: ${report.status}`,
    '',
    '## Decisive numbers',
    '',
    `- Quality: with Klauro ${report.live_summary.with_score}/100 vs baseline ${report.live_summary.without_score}/100 (delta ${signed(report.live_summary.quality_delta)})`,
    `- Provider tokens: with ${withArm.provider_total_tokens ?? 'unknown'} vs baseline ${withoutArm.provider_total_tokens ?? 'unknown'} (reduction ${report.live_summary.token_reduction_percentage ?? 'unknown'}%)`,
    `- Wall clock: with ${Math.round(withArm.duration_ms / 1000)}s vs baseline ${Math.round(withoutArm.duration_ms / 1000)}s (time reduction ${report.live_summary.time_reduction_percentage}%)`,
    `- Changed-file precision delta: ${signed(report.live_summary.changed_file_precision_delta)}`,
    `- Changed files: with [${withArm.changed_files.join(', ')}] vs baseline [${withoutArm.changed_files.join(', ')}]`,
    `- Validator: with ${withArm.tests_passed === true ? 'pass' : withArm.tests_passed === false ? 'fail' : 'not run'} vs baseline ${withoutArm.tests_passed === true ? 'pass' : withoutArm.tests_passed === false ? 'fail' : 'not run'}`,
    '',
    '## Context costs',
    '',
    `- Klauro work packet: ${report.with_klauro.packet_tokens} tokens; first files: ${report.with_klauro.first_files.join(', ') || 'none'}`,
    `- Index retrieval: ${report.index_retrieval_baseline.file_recall}% recall, ${report.index_retrieval_baseline.file_precision}% precision over expected inspect files, ${report.index_retrieval_baseline.estimated_tokens} retrieved-content tokens`,
    `- Retrieved files: ${report.index_retrieval_baseline.retrieved_files.join(', ') || 'none'}`,
    '',
    `Trial artifacts: ${report.live_pair.artifacts.trial_directory}`,
    '',
  ].join('\n');
}

function printRealRepoReport(report: RealRepoBenchmarkReport): void {
  console.log(`Real-repo existing-task live A/B: ${report.status.toUpperCase()}`);
  console.log(`  quality ${report.live_summary.with_score}/${report.live_summary.without_score} (delta ${signed(report.live_summary.quality_delta)})`);
  console.log(`  tokens with ${report.live_pair.with_klauro.provider_total_tokens ?? 'unknown'} vs baseline ${report.live_pair.without_klauro.provider_total_tokens ?? 'unknown'} (reduction ${report.live_summary.token_reduction_percentage ?? 'unknown'}%)`);
  console.log(`  time reduction ${report.live_summary.time_reduction_percentage}%; precision delta ${signed(report.live_summary.changed_file_precision_delta)}`);
  console.log(`  retrieval recall ${report.index_retrieval_baseline.file_recall}% precision ${report.index_retrieval_baseline.file_precision}% tokens ${report.index_retrieval_baseline.estimated_tokens}`);
}

function summarizeLivePair(pair: LiveAgentPairResult): NonNullable<ScenarioResult['live_summary']> {
  return {
    status: pair.evaluation.status,
    with_score: pair.evaluation.with_klauro_quality_score,
    without_score: pair.evaluation.without_klauro_quality_score,
    quality_delta: pair.evaluation.quality_score_delta,
    token_reduction_percentage: pair.evaluation.token_reduction_percentage,
    time_reduction_percentage: pair.evaluation.time_reduction_percentage,
    changed_file_precision_delta: pair.evaluation.changed_file_precision_delta,
  };
}

async function runScenario(outputRoot: string, scenario: SeededScenario): Promise<ScenarioResult> {
  const repoPath = path.join(outputRoot, scenario.id);
  await fs.remove(repoPath);
  await writeFiles(repoPath, scenario.files);
  const analysis = await analyzeProjectIncremental(repoPath);
  const cas = analysis.output;
  const packet = await getAgentWorkPacket(cas, repoPath, scenario.task as any) as any;
  const validation = validateAgentChange(cas, repoPath, {
    target: scenario.task.target,
    files: scenario.changed_files,
    diffText: scenario.diff_text,
    planText: scenario.task.instructions,
  });
  const packetText = JSON.stringify(packet).toLowerCase();
  const firstFiles = Array.isArray(packet.file_read_plan)
    ? packet.file_read_plan.map((item: any) => String(item.file || '')).filter(Boolean) as string[]
    : [];
  const fileHits = scenario.expected_files.filter(file => packetText.includes(file.toLowerCase()));
  const firstReadFileHits = scenario.expected_files.filter(file => firstFiles.some(first => first.endsWith(file) || first === file));
  const termHits = scenario.expected_terms.filter(term => packetText.includes(term.toLowerCase()));
  const fileHitRate = fileHits.length / scenario.expected_files.length;
  const firstReadFileHitRate = firstReadFileHits.length / scenario.expected_files.length;
  const termHitRate = termHits.length / scenario.expected_terms.length;
  const packetTokens = estimateTokens(JSON.stringify(packet));
  const withScore = scoreWithKlauro(fileHitRate, termHitRate, validation.status, packetTokens);
  const without = baselineProxyScore(repoPath, scenario);
  const indexRetrieval = indexRetrievalBaselineScore(repoPath, scenario);
  const status = withScore >= 85 ? 'pass' : withScore >= 70 ? 'warn' : 'fail';
  return {
    id: scenario.id,
    family: scenario.family,
    title: scenario.title,
    status,
    score: withScore,
    repo_path: repoPath,
    with_klauro: {
      score: withScore,
      packet_tokens: packetTokens,
      file_hit_rate: round(fileHitRate * 100),
      first_read_file_hit_rate: round(firstReadFileHitRate * 100),
      term_hit_rate: round(termHitRate * 100),
      validation_status: validation.status,
      first_files: firstFiles.slice(0, 8),
    },
    without_klauro_proxy: without,
    index_retrieval_baseline: indexRetrieval,
    deltas: {
      score_delta: withScore - without.score,
      file_reduction_percentage: percentReduction(without.estimated_files_to_read, firstFiles.length || 1),
      token_reduction_percentage: percentReduction(without.estimated_tokens, packetTokens),
    },
    findings: [
      fileHits.length === scenario.expected_files.length
        ? 'MCP packet included every expected guidance file.'
        : `MCP packet missed expected guidance files: ${scenario.expected_files.filter(file => !fileHits.includes(file)).join(', ')}`,
      firstReadFileHits.length === scenario.expected_files.length
        ? 'MCP first-read plan included every expected file.'
        : `MCP first-read plan did not include: ${scenario.expected_files.filter(file => !firstReadFileHits.includes(file)).join(', ')}`,
      termHits.length === scenario.expected_terms.length
        ? 'MCP packet included every expected task term.'
        : `MCP packet missed terms: ${scenario.expected_terms.filter(term => !termHits.includes(term)).join(', ')}`,
      `Validation status: ${validation.status}.`,
    ],
  };
}

export function formatSeededExistingTaskBenchmarkMarkdown(report: BenchmarkReport): string {
  const lines = [
    '# Seeded Existing-Project Task Proof',
    '',
    `Generated: ${report.generated_at}`,
    `Status: ${report.status}`,
    `Score: ${report.score}/100`,
    `Proof strength: ${report.summary.proof_strength}`,
    '',
    'This deterministic benchmark seeds small existing codebases with non-obvious engineering tasks and checks whether Klauro MCP returns the files, terms, and validation guidance an agent would need before broad rediscovery.',
    `Claim limit: ${report.summary.claim_limit}`,
    '',
    '## Summary',
    '',
    `- Scenarios: ${report.summary.passing_scenarios}/${report.summary.scenario_count} passing`,
    `- Families: ${report.summary.family_count}`,
    `- Average score delta vs blind proxy: +${report.summary.average_score_delta}`,
    `- Average file reduction: ${report.summary.average_file_reduction_percentage}%`,
    `- Average token reduction: ${report.summary.average_token_reduction_percentage}%`,
    `- Index-retrieval baseline (Cursor-style proxy): ${report.summary.average_index_retrieval_file_recall}% avg file recall, ${report.summary.average_index_retrieval_tokens} avg tokens; Klauro packets use ${report.summary.klauro_vs_index_retrieval_token_reduction_percentage}% fewer tokens`,
    `- Live copied-repo scenarios: ${report.summary.live_passing_scenarios}/${report.summary.live_scenarios} passing`,
    report.summary.live_scenarios
      ? `- Average live quality delta: +${report.summary.average_live_quality_delta}`
      : '',
    report.summary.live_scenarios
      ? `- Average live token reduction: ${report.summary.average_live_token_reduction_percentage}%`
      : '',
    '',
  ].filter(Boolean);
  for (const scenario of report.scenarios) {
    lines.push(`## ${scenario.title}`);
    lines.push('');
    lines.push(`Status: ${scenario.status} (${scenario.score}/100)`);
    lines.push(`Family: ${scenario.family}`);
    lines.push(`With Klauro: ${scenario.with_klauro.file_hit_rate}% guidance-file hit, ${scenario.with_klauro.first_read_file_hit_rate}% first-read hit, ${scenario.with_klauro.term_hit_rate}% term hit, ${scenario.with_klauro.packet_tokens} tokens`);
    lines.push(`Blind proxy: ${scenario.without_klauro_proxy.estimated_files_to_read} files, ${scenario.without_klauro_proxy.estimated_tokens} tokens`);
    lines.push(`Index-retrieval baseline (Cursor-style lexical indexing proxy): ${scenario.index_retrieval_baseline.file_recall}% file recall, ${scenario.index_retrieval_baseline.file_precision}% precision, ${scenario.index_retrieval_baseline.estimated_tokens} tokens (${scenario.index_retrieval_baseline.retrieved_files.length} files)`);
    lines.push(`Delta: +${scenario.deltas.score_delta} score, ${scenario.deltas.file_reduction_percentage}% fewer files, ${scenario.deltas.token_reduction_percentage}% fewer tokens`);
    if (scenario.live_summary) {
      lines.push(`Live A/B: ${scenario.live_summary.status}, with ${scenario.live_summary.with_score}/100 vs without ${scenario.live_summary.without_score}/100, quality delta ${signed(scenario.live_summary.quality_delta)}, token reduction ${scenario.live_summary.token_reduction_percentage ?? 'unknown'}%, time reduction ${scenario.live_summary.time_reduction_percentage}%`);
      lines.push(`Live trial: ${scenario.live_pair?.artifacts.trial_directory}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function writeLiveValidator(
  outputRoot: string,
  scenario: { id: string; live_checks: LiveFileCheck[]; semantic_rules: SeededScenario['semantic_rules']; lint_php?: boolean }
): Promise<string> {
  const validatorRoot = path.join(outputRoot, '.validators');
  await fs.ensureDir(validatorRoot);
  const validatorPath = path.join(validatorRoot, `${scenario.id}.cjs`);
  const payload = JSON.stringify({ checks: scenario.live_checks, semantic_rules: scenario.semantic_rules, lint_php: scenario.lint_php === true }, null, 2);
  await fs.writeFile(validatorPath, [
    'const fs = require("fs");',
    'const path = require("path");',
    'const { execFileSync } = require("child_process");',
    `const payload = ${payload};`,
    'const root = process.cwd();',
    'const failures = [];',
    'function git(args) {',
    '  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }',
    '  catch { return ""; }',
    '}',
    'const trackedChangedFiles = git(["diff", "--name-only"]).split("\\n").map(line => line.trim()).filter(Boolean);',
    'const untrackedFiles = git(["ls-files", "--others", "--exclude-standard"]).split("\\n").map(line => line.trim()).filter(Boolean).filter(file => !/\\.klauro-live-(metrics|result)\\.json$/.test(file));',
    'const changedFiles = [...new Set([...trackedChangedFiles, ...untrackedFiles])];',
    'const untrackedContent = untrackedFiles.map(file => { try { return fs.readFileSync(path.join(root, file), "utf8"); } catch { return ""; } }).join("\\n");',
    'const diffText = git(["diff", "--text"]);',
    'const addedDiffText = [diffText.split("\\n").filter(line => line.startsWith("+") && !line.startsWith("+++")).map(line => line.slice(1)).join("\\n"), untrackedContent].filter(Boolean).join("\\n");',
    'const rules = payload.semantic_rules || {};',
    'for (const file of rules.required_changed_files || []) {',
    '  if (!changedFiles.includes(file)) failures.push(`Required changed file missing from diff: ${file}`);',
    '}',
    'for (const file of rules.forbidden_changed_files || []) {',
    '  if (changedFiles.includes(file)) failures.push(`Forbidden file changed: ${file}`);',
    '}',
    'if (rules.allow_only_changed_files) {',
    '  const allowed = new Set(rules.required_changed_files || []);',
    '  for (const file of changedFiles) if (!allowed.has(file)) failures.push(`Unexpected changed file: ${file}`);',
    '}',
    'if (Number.isFinite(rules.max_changed_files) && changedFiles.length > rules.max_changed_files) {',
    '  failures.push(`Too many changed files: ${changedFiles.length} > ${rules.max_changed_files}`);',
    '}',
    'if (rules.require_test_change && !changedFiles.some(file => /test|spec|__tests__/i.test(file))) failures.push("No focused test file changed");',
    'if (rules.require_production_change && !changedFiles.some(file => /^(src|packages|apps)\\//.test(file) && !/test|spec|__tests__/i.test(file))) failures.push("No production source file changed");',
    'for (const pattern of rules.required_diff_patterns || []) {',
    '  if (!new RegExp(pattern, "mi").test(addedDiffText)) failures.push(`Added diff missing /${pattern}/`);',
    '}',
    'for (const pattern of rules.forbidden_diff_patterns || []) {',
    '  if (new RegExp(pattern, "mi").test(addedDiffText)) failures.push(`Added diff contains forbidden /${pattern}/`);',
    '}',
    'for (const check of payload.checks) {',
    '  const filePath = path.join(root, check.file);',
    '  if (!fs.existsSync(filePath)) { failures.push(`Missing ${check.file}`); continue; }',
    '  const content = fs.readFileSync(filePath, "utf8");',
    '  for (const pattern of check.patterns || []) {',
    '    if (!new RegExp(pattern, "m").test(content)) failures.push(`${check.file} missing /${pattern}/`);',
    '  }',
    '  for (const pattern of check.absent_patterns || []) {',
    '    if (new RegExp(pattern, "m").test(content)) failures.push(`${check.file} still contains forbidden /${pattern}/`);',
    '  }',
    '}',
    'if (payload.lint_php) {',
    '  for (const file of changedFiles.filter(file => file.endsWith(".php"))) {',
    '    try { execFileSync("php", ["-l", path.join(root, file)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }); }',
    '    catch (error) { failures.push(`php -l failed for ${file}: ${String(error.stderr || error.stdout || error.message).trim().slice(0, 300)}`); }',
    '  }',
    '}',
    'if (failures.length) { console.error(failures.join("\\n")); process.exit(1); }',
    'console.log("live existing-task validation passed");',
    '',
  ].join('\n'));
  return validatorPath;
}

function tenantTaskFiles(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'package.json': '{"scripts":{"test":"node tests/taskService.test.js"},"type":"module"}',
    'src/domain/task.ts': [
      'export interface Task {',
      '  id: string;',
      '  workspaceId: string;',
      '  projectId: string;',
      '  title: string;',
      '  assigneeId: string;',
      '}',
    ].join('\n'),
    'src/policies/workspacePolicy.ts': [
      'export function assertWorkspaceMember(workspaceId: string, userId: string) {',
      '  if (!workspaceId || !userId) throw new Error("Workspace membership is required");',
      '}',
    ].join('\n'),
    'src/repositories/taskRepository.ts': [
      'import type { Task } from "../domain/task";',
      'export class TaskRepository {',
      '  private readonly rows: Task[] = [];',
      '  create(input: Omit<Task, "id">): Task {',
      '    const task = { id: `task_${this.rows.length + 1}`, ...input };',
      '    this.rows.push(task);',
      '    return task;',
      '  }',
      '  listVisibleForUser(userId: string, workspaceId: string): Task[] {',
      '    return this.rows.filter(task => task.assigneeId === userId && task.workspaceId === workspaceId);',
      '  }',
      '}',
    ].join('\n'),
    'src/services/taskService.ts': [
      'import { TaskRepository } from "../repositories/taskRepository";',
      'import { assertWorkspaceMember } from "../policies/workspacePolicy";',
      'export class TaskService {',
      '  constructor(private readonly repository: TaskRepository) {}',
      '  createTask(input: { workspaceId: string; projectId: string; title: string; assigneeId: string }) {',
      '    if (!input.title.trim()) throw new Error("Task title is required");',
      '    assertWorkspaceMember(input.workspaceId, input.assigneeId);',
      '    return this.repository.create(input);',
      '  }',
      '  listVisibleForUser(userId: string, workspaceId: string) {',
      '    assertWorkspaceMember(workspaceId, userId);',
      '    return this.repository.listVisibleForUser(userId, workspaceId);',
      '  }',
      '}',
    ].join('\n'),
    'src/controllers/taskController.ts': [
      'import { TaskService } from "../services/taskService";',
      'export function makeTaskController(taskService: TaskService) {',
      '  return {',
      '    listTasks: (req: { workspaceId: string; userId: string }) => taskService.listVisibleForUser(req.userId, req.workspaceId),',
      '  };',
      '}',
    ].join('\n'),
    'tests/taskService.test.js': 'import assert from "node:assert/strict"; assert.ok(true);',
    'tests/taskVisibility.test.ts': 'import assert from "node:assert/strict"; assert.ok(true);',
    ...overrides,
  };
}

function authSystemFiles(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'package.json': '{"scripts":{"test":"node tests/authService.test.js"},"type":"module"}',
    'src/auth/authService.ts': [
      'import { SessionRepository } from "./sessionRepository";',
      'import { OidcClient } from "./oidcClient";',
      'export class AuthService {',
      '  constructor(private readonly sessions: SessionRepository, private readonly oidc: OidcClient) {}',
      '  async login(input: { idToken: string }) {',
      '    const identity = await this.oidc.verifyIdToken(input.idToken);',
      '    if (!identity) throw new Error("Invalid credentials");',
      '    return this.sessions.createSession(identity.subject);',
      '  }',
      '}',
    ].join('\n'),
    'src/auth/oidcClient.ts': 'export class OidcClient { async verifyIdToken(idToken: string) { return idToken ? { subject: idToken } : null; } }',
    'src/auth/sessionRepository.ts': [
      'export interface Session { id: string; userId: string; }',
      'export class SessionRepository {',
      '  private readonly sessions: Session[] = [];',
      '  createSession(userId: string): Session {',
      '    const session = { id: `session_${this.sessions.length + 1}`, userId };',
      '    this.sessions.push(session);',
      '    return session;',
      '  }',
      '}',
    ].join('\n'),
    'src/auth/authPolicy.ts': 'export function assertAuthenticated(userId: string) { if (!userId) throw new Error("Authentication required"); }',
    'tests/authService.test.js': 'import assert from "node:assert/strict"; assert.ok(true);',
    ...overrides,
  };
}

function distributedAuthFiles(): Record<string, string> {
  return {
    'package.json': '{"scripts":{"test":"node tests/authService.test.js"},"type":"module"}',
    'src/auth/authService.ts': [
      'import { AuditLogger } from "../audit/auditLogger";',
      'import { PasswordCredentialVerifier } from "./passwordCredentialVerifier";',
      'import { SessionRepository } from "./sessionRepository";',
      'export class AuthService {',
      '  constructor(',
      '    private readonly sessions: SessionRepository,',
      '    private readonly passwords: PasswordCredentialVerifier,',
      '    private readonly audit: AuditLogger,',
      '  ) {}',
      '  async login(input: { email: string; password: string; ipAddress: string }) {',
      '    const user = await this.passwords.verify(input.email, input.password);',
      '    if (!user) {',
      '      this.audit.record({ type: "auth.login_rejected", subject: input.email, ipAddress: input.ipAddress });',
      '      throw new Error("Invalid credentials");',
      '    }',
      '    const session = this.sessions.createSession(user.id);',
      '    this.audit.record({ type: "auth.login_succeeded", subject: user.id, ipAddress: input.ipAddress });',
      '    return session;',
      '  }',
      '}',
    ].join('\n'),
    'src/auth/authModule.ts': [
      'import { AuditLogger } from "../audit/auditLogger";',
      'import { AuthService } from "./authService";',
      'import { PasswordCredentialVerifier } from "./passwordCredentialVerifier";',
      'import { SessionRepository } from "./sessionRepository";',
      'export function makeAuthService() {',
      '  return new AuthService(new SessionRepository(), new PasswordCredentialVerifier(), new AuditLogger());',
      '}',
    ].join('\n'),
    'src/auth/passwordCredentialVerifier.ts': [
      'export class PasswordCredentialVerifier {',
      '  async verify(email: string, password: string) {',
      '    return email && password ? { id: `user:${email}` } : null;',
      '  }',
      '}',
    ].join('\n'),
    'src/auth/oidcClient.ts': [
      'export class OidcClient {',
      '  async verifyIdToken(idToken: string) {',
      '    return idToken && idToken.startsWith("oidc:") ? { subject: idToken.slice(5) } : null;',
      '  }',
      '}',
    ].join('\n'),
    'src/auth/sessionRepository.ts': [
      'export interface Session { id: string; userId: string; }',
      'export class SessionRepository {',
      '  private readonly sessions: Session[] = [];',
      '  createSession(userId: string): Session {',
      '    const session = { id: `session_${this.sessions.length + 1}`, userId };',
      '    this.sessions.push(session);',
      '    return session;',
      '  }',
      '  listForUser(userId: string): Session[] {',
      '    return this.sessions.filter(session => session.userId === userId);',
      '  }',
      '}',
    ].join('\n'),
    'src/auth/mfaService.ts': [
      'export class MfaService {',
      '  requiresStepUp(userId: string) { return userId.startsWith("admin:"); }',
      '}',
    ].join('\n'),
    'src/api/sessionController.ts': [
      'import { AuthService } from "../auth/authService";',
      'export function makeSessionController(auth: AuthService) {',
      '  return {',
      '    login: (req: { body: { email: string; password: string }; ipAddress: string }) => auth.login({',
      '      email: req.body.email,',
      '      password: req.body.password,',
      '      ipAddress: req.ipAddress,',
      '    }),',
      '  };',
      '}',
    ].join('\n'),
    'src/api/adminSessionController.ts': [
      'import { SessionRepository } from "../auth/sessionRepository";',
      'export function makeAdminSessionController(sessions: SessionRepository) {',
      '  return { listUserSessions: (userId: string) => sessions.listForUser(userId) };',
      '}',
    ].join('\n'),
    'src/audit/auditLogger.ts': [
      'export interface AuditEvent { type: string; subject: string; ipAddress: string; }',
      'export class AuditLogger {',
      '  readonly events: AuditEvent[] = [];',
      '  record(event: AuditEvent) { this.events.push(event); }',
      '}',
    ].join('\n'),
    'src/security/authPolicy.ts': 'export function assertAuthenticated(userId: string) { if (!userId) throw new Error("Authentication required"); }',
    'tests/authService.test.js': 'import assert from "node:assert/strict"; assert.ok(true);',
    'tests/sessionController.test.js': 'import assert from "node:assert/strict"; assert.ok(true);',
  };
}

function monolithTaskFiles(): Record<string, string> {
  return {
    'package.json': '{"scripts":{"test":"node tests/taskService.test.js"},"type":"module"}',
    'src/taskModule.ts': [
      'export interface RequestContext { workspaceId: string; userId: string; title?: string; }',
      'const rows: Array<{ id: string; workspaceId: string; title: string; assigneeId: string }> = [];',
      'function assertWorkspaceMember(workspaceId: string, userId: string) {',
      '  if (!workspaceId || !userId) throw new Error("Workspace membership is required");',
      '}',
      'export function listTasks(req: RequestContext) {',
      '  assertWorkspaceMember(req.workspaceId, req.userId);',
      '  return rows.filter(task => task.workspaceId === req.workspaceId && task.assigneeId === req.userId);',
      '}',
      'export function createTask(req: RequestContext) {',
      '  assertWorkspaceMember(req.workspaceId, req.userId);',
      '  const task = { id: `task_${rows.length + 1}`, workspaceId: req.workspaceId, title: req.title || "Untitled", assigneeId: req.userId };',
      '  rows.push(task);',
      '  return task;',
      '}',
    ].join('\n'),
    'src/controllers/taskController.ts': [
      'import { listTasks, createTask } from "../taskModule";',
      'export function makeTaskController() {',
      '  return { listTasks, createTask };',
      '}',
    ].join('\n'),
    'src/services/taskService.ts': [
      'export class TaskService {',
      '  listVisibleForUser() { throw new Error("not extracted yet"); }',
      '}',
    ].join('\n'),
    'src/repositories/taskRepository.ts': [
      'export class TaskRepository {',
      '  listVisibleForUser() { throw new Error("not extracted yet"); }',
      '}',
    ].join('\n'),
    'tests/taskService.test.js': 'import assert from "node:assert/strict"; assert.ok(true);',
  };
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fs.ensureDir(path.dirname(absolute));
    await fs.writeFile(absolute, `${contents.trim()}\n`);
  }
}

function scoreWithKlauro(fileHitRate: number, termHitRate: number, validationStatus: string, packetTokens: number): number {
  let score = 35;
  score += Math.round(fileHitRate * 35);
  score += Math.round(termHitRate * 20);
  score += validationStatus === 'fail' ? 0 : validationStatus === 'warn' ? 6 : 10;
  if (packetTokens > 8000) score -= 10;
  return Math.max(0, Math.min(100, score));
}

function baselineProxyScore(repoPath: string, scenario: SeededScenario): ScenarioResult['without_klauro_proxy'] {
  const sourceFiles = listSourceFiles(repoPath);
  const estimatedFiles = Math.max(scenario.expected_files.length + 2, Math.ceil(sourceFiles.length * 0.75));
  const estimatedTokens = Math.max(estimateRepoTokens(repoPath), estimatedFiles * 1200);
  const score = Math.max(35, 72 - Math.max(0, estimatedFiles - scenario.expected_files.length) * 4);
  return {
    score,
    estimated_files_to_read: estimatedFiles,
    estimated_tokens: estimatedTokens,
  };
}

export function indexRetrievalBaselineScore(repoPath: string, scenario: Pick<SeededScenario, 'task' | 'expected_files'>): ScenarioResult['index_retrieval_baseline'] {
  const sourceFiles = listSourceFiles(repoPath);
  const queryTerms = tokenizeForRetrieval(`${scenario.task.instructions} ${scenario.task.target}`);
  const documents = sourceFiles.map(absolute => {
    const file = path.relative(repoPath, absolute).replace(/\\/g, '/');
    let content = '';
    try {
      content = fs.readFileSync(absolute, 'utf8');
    } catch {
      content = '';
    }
    return {
      file,
      termFrequencies: termFrequenciesForRetrieval(content),
      pathTokens: tokenizeForRetrieval(file),
      chars: content.length,
    };
  });
  const averageLength = Math.max(1, documents.reduce((sum, doc) => sum + doc.chars, 0) / Math.max(1, documents.length));
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequency.set(term, documents.filter(doc => doc.termFrequencies.has(term) || doc.pathTokens.has(term)).length);
  }
  const k1 = 1.2;
  const b = 0.75;
  const ranked = documents
    .map(doc => {
      let score = 0;
      for (const term of queryTerms) {
        const contentFrequency = doc.termFrequencies.get(term) || 0;
        const pathBoost = doc.pathTokens.has(term) ? 3 : 0;
        const frequency = contentFrequency + pathBoost;
        if (frequency === 0) continue;
        const df = documentFrequency.get(term) || 1;
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        const lengthNormalization = k1 * (1 - b + b * (doc.chars / averageLength));
        score += idf * ((frequency * (k1 + 1)) / (frequency + lengthNormalization));
      }
      return { ...doc, score };
    })
    .sort((left, right) => right.score - left.score);
  const topK = ranked.slice(0, 6).filter(doc => doc.score > 0);
  const retrievedFiles = topK.map(doc => doc.file);
  const expected = new Set(scenario.expected_files);
  const hits = retrievedFiles.filter(file => expected.has(file)).length;
  const precision = retrievedFiles.length ? hits / retrievedFiles.length : 0;
  const recall = scenario.expected_files.length ? hits / scenario.expected_files.length : 0;
  const estimatedTokens = Math.round(topK.reduce((total, doc) => total + doc.chars / 4, 0));
  const tokenEfficiency = Math.min(1, 8000 / Math.max(1, estimatedTokens));
  const score = Math.round(recall * 50 + precision * 30 + tokenEfficiency * 20);
  return {
    score,
    retrieved_files: retrievedFiles,
    file_precision: round(precision * 100),
    file_recall: round(recall * 100),
    estimated_tokens: estimatedTokens,
  };
}

function tokenizeForRetrieval(text: string): Set<string> {
  return new Set(retrievalTokens(text));
}

function termFrequenciesForRetrieval(text: string): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of retrievalTokens(text)) {
    frequencies.set(token, (frequencies.get(token) || 0) + 1);
  }
  return frequencies;
}

function retrievalTokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 2);
}

function summarizeFamilies(scenarios: ScenarioResult[]): BenchmarkReport['summary']['families'] {
  const families = {} as BenchmarkReport['summary']['families'];
  for (const family of [...new Set(scenarios.map(scenario => scenario.family))] as TaskFamily[]) {
    const items = scenarios.filter(scenario => scenario.family === family);
    const score = Math.round(average(items.map(item => item.score)));
    families[family] = {
      scenarios: items.length,
      average_score: score,
      status: score >= 85 ? 'pass' : score >= 70 ? 'warn' : 'fail',
    };
  }
  return families;
}

function parseArgs(argv: string[]): Args {
  let outputRoot = path.join(os.tmpdir(), `klauro-existing-task-benchmark-${Date.now()}`);
  let reportPath: string | null = path.join(process.cwd(), '.klauro-existing-task-benchmark', 'latest-report.json');
  let markdownPath: string | null = path.join(process.cwd(), '.klauro-existing-task-benchmark', 'latest-report.md');
  let live = false;
  let withoutArmRetrieval = false;
  let realRepoPath: string | null = null;
  let realTaskId: string | null = null;
  const liveConfig: LiveAgentCommandConfig = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--work-root') outputRoot = path.resolve(argv[++i]);
    else if (arg === '--output') reportPath = path.resolve(argv[++i]);
    else if (arg === '--markdown') markdownPath = path.resolve(argv[++i]);
    else if (arg === '--live') live = true;
    else if (arg === '--without-arm-retrieval') withoutArmRetrieval = true;
    else if (arg === '--real-repo') realRepoPath = path.resolve(argv[++i]);
    else if (arg === '--real-task') realTaskId = argv[++i];
    else if (arg === '--agent-with-cmd') liveConfig.withKlauro = argv[++i];
    else if (arg === '--agent-without-cmd') liveConfig.withoutKlauro = argv[++i];
    else if (arg === '--orchestrator-cmd') liveConfig.orchestrator = argv[++i];
    else if (arg === '--timeout-ms') liveConfig.timeoutMs = Number(argv[++i]);
    else if (arg === '--test-timeout-ms') liveConfig.testTimeoutMs = Number(argv[++i]);
    else if (arg === '--max-live-tasks') liveConfig.maxLiveTasks = Number(argv[++i]);
    else if (arg === '--live-task-category') liveConfig.liveTaskCategories = [...(liveConfig.liveTaskCategories || []), argv[++i]];
    else if (arg === '--live-task-id') liveConfig.liveTaskCategories = [...(liveConfig.liveTaskCategories || []), argv[++i]];
    else if (arg === '--live-task-type') liveConfig.liveTaskTypes = [...(liveConfig.liveTaskTypes || []), argv[++i]];
    else if (arg === '--no-output') {
      reportPath = null;
      markdownPath = null;
    } else if (arg === '--help' || arg === '-h') {
      console.log([
        'Usage: npm run agent-existing-task-benchmark -- [options]',
        '',
        'Options:',
        '  --work-root /path',
        '  --output /path/report.json',
        '  --markdown /path/report.md',
        '  --live',
        '  --without-arm-retrieval        Give the without arm Cursor-style index-retrieval candidate files.',
        '  --real-repo /path              Run a defined real-repo live task instead of the seeded scenarios (requires --live).',
        `  --real-task task-id            Real-repo task to run (default ${REAL_REPO_SCENARIOS[0].id}).`,
        '  --agent-with-cmd "codex exec ... - < {prompt_file}"',
        '  --agent-without-cmd "codex exec ... - < {prompt_file}"',
        '  --max-live-tasks N',
        '  --live-task-category family-id',
        '  --live-task-id scenario-id',
        '  --live-task-type debug|modify|trace',
        '  --timeout-ms N',
        '  --no-output',
      ].join('\n'));
      process.exit(0);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option ${arg}. Run with --help to list supported options.`);
    }
  }
  return { outputRoot, reportPath, markdownPath, live, liveConfig, withoutArmRetrieval, realRepoPath, realTaskId };
}

function printReport(report: BenchmarkReport): void {
  console.log(`Seeded existing-task benchmark: ${report.status.toUpperCase()} (${report.score}/100)`);
  for (const scenario of report.scenarios) {
    const live = scenario.live_summary
      ? `, live ${scenario.live_summary.status} ${scenario.live_summary.with_score}/${scenario.live_summary.without_score} delta ${signed(scenario.live_summary.quality_delta)}`
      : '';
    console.log(`${scenario.status.toUpperCase().padEnd(4)} ${scenario.id} - ${scenario.score}/100, delta +${scenario.deltas.score_delta}${live}`);
  }
}

function diff(file: string, before: string, after: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@',
    `-${before}`,
    `+${after}`,
  ].join('\n');
}

function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  const ignored = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'vendor', 'vendors', 'var', 'target', '.next', '.turbo', '.venv', 'venv', '__pycache__']);
  function visit(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.(ts|tsx|js|jsx|py|go|rs|java|cs|php)$/.test(entry.name)) files.push(absolute);
    }
  }
  visit(root);
  return files;
}

function estimateRepoTokens(root: string): number {
  return Math.max(1, Math.round(listSourceFiles(root).reduce((sum, file) => {
    return sum + fs.readFileSync(file, 'utf8').length;
  }, 0) / 4));
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

function percentReduction(before: number, after: number): number {
  if (before <= 0) return 0;
  return Math.round(((before - after) / before) * 100);
}

function average(values: number[]): number {
  const finite = values.filter(value => Number.isFinite(value));
  if (finite.length === 0) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function round(value: number): number {
  return Math.round(value);
}

function signed(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
