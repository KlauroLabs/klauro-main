import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { describeLiveAgentExecutionProfile, evaluateLivePairDeterministically, runLiveAgentPairFromWorkspaces, type LiveAgentArmResult, type LiveAgentPairInput } from './agent-live-trial';

test('live command profile detects lean Claude measurement mode', () => {
  const lean = describeLiveAgentExecutionProfile({
    withKlauro: 'claude -p --safe-mode --no-session-persistence --permission-mode bypassPermissions --add-dir {workspace} -- "$(cat {prompt_file})"',
    withoutKlauro: 'claude -p --safe-mode --no-session-persistence --permission-mode bypassPermissions --add-dir {workspace} -- "$(cat {prompt_file})"',
  });
  assert.equal(lean.profile, 'lean');
  assert.deepEqual(lean.warnings, []);

  const full = describeLiveAgentExecutionProfile({
    withKlauro: 'claude -p --permission-mode bypassPermissions --add-dir {workspace} "$(cat {prompt_file})"',
    withoutKlauro: 'claude -p --permission-mode bypassPermissions --add-dir {workspace} "$(cat {prompt_file})"',
  });
  assert.equal(full.profile, 'full-agent');
  assert.match(full.warnings.join('\n'), /safe-mode/);
  assert.match(full.warnings.join('\n'), /no-session-persistence/);
  assert.match(full.warnings.join('\n'), /--add-dir consume the prompt/);
});

test('live evaluator scores greenfield architecture continuity beyond command completion', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-live-eval-'));
  const withWorkspace = path.join(root, 'with');
  const withoutWorkspace = path.join(root, 'without');
  await writeFiles(withWorkspace, {
    'package.json': '{"type":"module"}',
    'src/http/routes.ts': 'export const routes = ["POST /requests"];',
    'src/services/work-intake.service.ts': 'import type { Request } from "../domain/model"; export class WorkIntakeService {}',
    'src/repositories/work-intake.repository.ts': 'export interface WorkIntakeRepository { save(): void }',
    'src/domain/model.ts': 'export interface Organization { id: string } export interface Request { organizationId: Organization["id"] }',
    'src/auth/policy.ts': 'export function assertTenantRole() { return true; }',
    'src/worker/escalation-digest.worker.ts': 'export function runDigest() { return true; }',
    'migrations/001_initial.sql': 'create table requests (id text primary key);',
    'tests/work-intake.service.test.ts': 'test("service", () => true);',
  });
  await writeFiles(withoutWorkspace, {
    'package.json': '{"type":"module"}',
    'src/domain/notifications.ts': 'export interface Notification { id: string }',
    'src/domain/auditEvents.ts': 'export interface AuditEvent { id: string }',
    'src/services/intakeService.ts': 'export class IntakeService {}',
    'src/persistence/repositories.ts': 'export interface Repository { save(): void }',
    'src/scheduler/escalationDigest.ts': 'export function digest() { return true; }',
    'tests/intakeService.test.ts': 'test("service", () => true);',
  });

  const input = greenfieldInput('greenfield-scratch-build', 'Build a production-shaped multi-tenant work intake platform with persistence and a scheduled escalation digest.');
  const result = await evaluateLivePairDeterministically(
    input,
    arm('with-klauro', withWorkspace, 90_000),
    arm('without-klauro', withoutWorkspace, 120_000)
  );

  assert.equal(result.with_klauro_architecture_score, 100);
  assert.ok((result.without_klauro_architecture_score || 0) < 90);
  assert.ok(result.quality_score_delta > 0);
  assert.ok(result.reasons.some(reason => reason.includes('Architecture continuity score')));
});

test('live evaluator requires deeper focused tests for continuation waves', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-live-continuation-eval-'));
  const withWorkspace = path.join(root, 'with');
  const withoutWorkspace = path.join(root, 'without');
  const commonFiles = {
    'package.json': '{"type":"module"}',
    'src/http/routes.ts': 'export const routes = ["POST /portal", "POST /webhook"];',
    'src/services/work-intake.service.ts': 'export class WorkIntakeService { portal(){} attachment(){} webhook(){} }',
    'src/repositories/work-intake.repository.ts': 'export interface WorkIntakeRepository { save(): void }',
    'src/domain/model.ts': 'export interface RequestAttachment {} export interface SavedOperationalView {} export interface SlaBreachNotification {}',
    'src/auth/policy.ts': 'export function assertTenantRole() { return true; }',
    'src/worker/escalation-digest.worker.ts': 'export function runDigest() { return true; }',
    'migrations/001_initial.sql': 'create table requests (id text primary key);',
    'migrations/002_continuation.sql': 'create table attachments (id text primary key);',
  };
  await writeFiles(withWorkspace, {
    ...commonFiles,
    'tests/work-intake.service.test.ts': 'test("service", () => true);',
    'tests/portal.test.ts': 'test("portal", () => true);',
    'tests/webhook.test.ts': 'test("webhook", () => true);',
  });
  await writeFiles(withoutWorkspace, {
    ...commonFiles,
    'tests/work-intake.service.test.ts': 'test("service", () => true);',
    'tests/portal.test.ts': 'test("portal", () => true);',
  });

  const input = greenfieldInput(
    'greenfield-scratch-continuation',
    'Continue the existing codebase by adding customer portal request submission, request attachments, SLA breach notification records, saved operational views, and external webhook intake.'
  );
  const result = await evaluateLivePairDeterministically(
    input,
    arm('with-klauro', withWorkspace, 160_000),
    arm('without-klauro', withoutWorkspace, 210_000)
  );

  assert.equal(result.with_klauro_architecture_score, 100);
  assert.ok((result.without_klauro_architecture_score || 0) < 100);
  assert.ok(result.reasons.some(reason => reason.includes('Too little focused continuation test evidence')));
});

test('live evaluator treats UI entry files as architecture entry boundaries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-live-ui-entry-eval-'));
  const withWorkspace = path.join(root, 'with');
  const withoutWorkspace = path.join(root, 'without');
  await writeFiles(withWorkspace, {
    'package.json': '{"type":"module"}',
    'src/entry.tsx': 'import { App } from "./App"; export const root = App;',
    'src/App.tsx': 'export function App() { return null; }',
    'src/domain/project-health.ts': 'export interface ProjectHealth { workspaceId: string; status: string }',
    'src/repository/project-health-repository.ts': 'export class ProjectHealthRepository {}',
    'src/service/project-health-service.ts': 'export class ProjectHealthService {}',
    'src/ui/components/Dashboard.tsx': 'export function Dashboard() { return null; }',
    'tests/service/project-health-service.test.ts': 'test("service", () => true);',
  });
  await writeFiles(withoutWorkspace, {
    'package.json': '{"type":"module"}',
    'src/components/Dashboard.tsx': 'export function Dashboard() { return null; }',
    'tests/dashboard.test.tsx': 'test("dashboard", () => true);',
  });

  const input = greenfieldInput(
    'greenfield-scratch-build',
    'Build a React operations dashboard that shows project health, analysis readiness, and proposal preview status.'
  );
  const result = await evaluateLivePairDeterministically(
    input,
    arm('with-klauro', withWorkspace, 80_000),
    arm('without-klauro', withoutWorkspace, 100_000)
  );

  assert.equal(result.with_klauro_architecture_score, 100);
  assert.ok((result.without_klauro_architecture_score || 0) < 100);
  assert.doesNotMatch(result.reasons.join('\n'), /With Klauro architecture finding: No route\/controller\/entry boundary/);
});

test('live pair can continue from separate prior workspaces for each arm', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-live-separate-workspaces-'));
  const withBase = path.join(root, 'with-base');
  const withoutBase = path.join(root, 'without-base');
  await writeFiles(withBase, {
    'package.json': '{"type":"module"}',
    'src/domain/concepts.ts': 'export interface Workspace { id: string }',
  });
  await writeFiles(withoutBase, {
    'package.json': '{"type":"module"}',
    'src/domain/local-workspace.ts': 'export interface LocalWorkspace { id: string }',
  });

  const input = greenfieldInput(
    'greenfield-scratch-continuation',
    'Continue the existing codebase by adding workspace activity summaries without rebuilding workspace concepts.'
  );
  const command = [
    'node -e "',
    "const fs=require('fs');",
    "fs.mkdirSync('src/services',{recursive:true});",
    "fs.writeFileSync('src/services/activity-summary.service.ts','export const activitySummary = true;\\n');",
    `fs.writeFileSync(process.argv[1], JSON.stringify({ task_success: true, quality_score: 95, files_read: 1, provider_total_tokens: 1000 }));`,
    '" {result_file}',
  ].join('');

  const result = await runLiveAgentPairFromWorkspaces(input, {
    withKlauro: command,
    withoutKlauro: command,
    workRoot: path.join(root, 'trials'),
    testCommand: 'test -f src/services/activity-summary.service.ts',
    timeoutMs: 60_000,
    testTimeoutMs: 60_000,
  }, {
    withKlauroRepoPath: withBase,
    withoutKlauroRepoPath: withoutBase,
  });

  assert.ok(await fs.pathExists(path.join(result.with_klauro.workspace, 'src/domain/concepts.ts')));
  assert.ok(await fs.pathExists(path.join(result.without_klauro.workspace, 'src/domain/local-workspace.ts')));
  assert.ok(!(await fs.pathExists(path.join(result.with_klauro.workspace, 'src/domain/local-workspace.ts'))));
  assert.ok(!(await fs.pathExists(path.join(result.without_klauro.workspace, 'src/domain/concepts.ts'))));
  assert.equal(result.with_klauro.command_passed, true);
  assert.equal(result.without_klauro.command_passed, true);
});

test('live pair parses Claude JSON usage including cache tokens', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-live-claude-usage-'));
  const withBase = path.join(root, 'with-base');
  const withoutBase = path.join(root, 'without-base');
  await writeFiles(withBase, { 'package.json': '{"type":"module"}' });
  await writeFiles(withoutBase, { 'package.json': '{"type":"module"}' });

  const input = greenfieldInput('greenfield-scratch-build', 'Build a tiny proof.');
  const command = [
    'node -e "',
    "console.log(JSON.stringify({",
    "usage:{input_tokens:10,cache_creation_input_tokens:20,cache_read_input_tokens:30,output_tokens:5},",
    "modelUsage:{ignored:{inputTokens:999,outputTokens:999,cacheReadInputTokens:999,cacheCreationInputTokens:999}},",
    "result:'done'",
    "}));",
    '"',
  ].join('');

  const result = await runLiveAgentPairFromWorkspaces(input, {
    withKlauro: command,
    withoutKlauro: command,
    workRoot: path.join(root, 'trials'),
    timeoutMs: 60_000,
  }, {
    withKlauroRepoPath: withBase,
    withoutKlauroRepoPath: withoutBase,
  });

  assert.equal(result.with_klauro.provider_input_tokens, 60);
  assert.equal(result.with_klauro.provider_output_tokens, 5);
  assert.equal(result.with_klauro.provider_total_tokens, 65);
  assert.equal(result.with_klauro.provider_direct_input_tokens, 10);
  assert.equal(result.with_klauro.provider_cache_creation_input_tokens, 20);
  assert.equal(result.with_klauro.provider_cache_read_input_tokens, 30);
  assert.equal(result.with_klauro.provider_direct_total_tokens, 35);
  assert.equal(result.without_klauro.provider_total_tokens, 65);
  assert.equal(result.evaluation.token_reduction_percentage, 0);
});

test('live evaluator allows tiny token tradeoff only for material quality wins', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-live-token-tradeoff-'));
  const withWorkspace = path.join(root, 'with');
  const withoutWorkspace = path.join(root, 'without');
  await writeFiles(withWorkspace, { 'package.json': '{"type":"module"}' });
  await writeFiles(withoutWorkspace, { 'package.json': '{"type":"module"}' });

  const withArm = arm('with-klauro', withWorkspace, 105);
  const withoutArm = arm('without-klauro', withoutWorkspace, 100);
  withArm.files_changed = 1;
  withArm.changed_files = ['src/service.ts'];
  withArm.lines_added = 12;
  withArm.lines_deleted = 0;
  withArm.self_reported_quality_score = 100;
  withoutArm.files_changed = 1;
  withoutArm.changed_files = ['src/service.ts'];
  withoutArm.lines_added = 20;
  withoutArm.lines_deleted = 0;
  withoutArm.self_reported_quality_score = 70;
  withArm.provider_direct_total_tokens = 105;
  withoutArm.provider_direct_total_tokens = 100;
  withoutArm.validation_passed = false;
  withoutArm.tests_passed = false;
  withoutArm.status = 'fail';

  const result = await evaluateLivePairDeterministically(
    {
      repo: 'fixture',
      repoPath: root,
      taskId: 'small-token-tradeoff',
      taskLabel: 'Small token tradeoff',
      taskCategory: 'bug-fix-live-edits',
      task: {
        task_type: 'modify',
        target: 'service behavior',
        instructions: 'Fix the service behavior.',
        success_criteria: ['Service behavior is correct.'],
        related_paths: ['src/service.ts'],
      } as any,
      expectedOutcome: 'Service behavior is correct.',
      fileReadPlan: [{ file: 'src/service.ts' }],
    },
    withArm,
    withoutArm
  );

  assert.equal(result.token_reduction_percentage, -5);
  assert.equal(result.status, 'pass');
  assert.ok(result.quality_score_delta >= 10);
  assert.ok(result.reasons.some(reason => reason.includes('small-tradeoff allowance')));
});

test('live evaluator scores time to valid solution when the baseline diff fails validation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-live-valid-solution-time-'));
  const withWorkspace = path.join(root, 'with');
  const withoutWorkspace = path.join(root, 'without');
  await writeFiles(withWorkspace, { 'package.json': '{"type":"module"}' });
  await writeFiles(withoutWorkspace, { 'package.json': '{"type":"module"}' });

  const withArm = arm('with-klauro', withWorkspace, 10_000);
  const withoutArm = arm('without-klauro', withoutWorkspace, 12_000);
  withArm.duration_ms = 120_000;
  withoutArm.duration_ms = 60_000;
  withoutArm.validation_passed = false;
  withoutArm.tests_passed = false;
  withoutArm.status = 'fail';

  const result = await evaluateLivePairDeterministically(
    {
      repo: 'fixture',
      repoPath: root,
      taskId: 'migration-change',
      taskLabel: 'Add migration-backed field',
      taskCategory: 'schema-migration-changes',
      task: {
        task_type: 'modify',
        target: 'schema migration',
        instructions: 'Add a persisted field with a migration and focused test.',
        success_criteria: ['Migration exists', 'Focused test passes'],
        related_paths: ['src/domain/task.ts', 'migrations/002_add_task_due_at.sql', 'tests/taskService.test.js'],
      } as any,
      expectedOutcome: 'Persisted field added through the existing migration path.',
      fileReadPlan: [{ file: 'src/domain/task.ts' }, { file: 'migrations/001_create_tasks.sql' }],
    },
    withArm,
    withoutArm
  );

  assert.equal(result.with_klauro_success, true);
  assert.equal(result.without_klauro_success, false);
  assert.equal(result.time_reduction_percentage, 100);
  assert.ok(result.reasons.some(reason => reason.includes('time to valid solution')));
});

test('live pair status follows evaluator verdict instead of failing when the baseline arm fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-live-status-evaluator-'));
  const withBase = path.join(root, 'with-base');
  const withoutBase = path.join(root, 'without-base');
  await writeFiles(withBase, { 'package.json': '{"type":"module"}' });
  await writeFiles(withoutBase, { 'package.json': '{"type":"module"}' });

  const input = greenfieldInput('greenfield-scratch-build', 'Build a production-shaped multi-tenant work intake platform with persistence and a scheduled escalation digest.');
  const withCommand = [
    'node -e "',
    "const fs=require('fs');",
    "fs.mkdirSync('src/http',{recursive:true});",
    "fs.mkdirSync('src/services',{recursive:true});",
    "fs.mkdirSync('src/repositories',{recursive:true});",
    "fs.mkdirSync('src/domain',{recursive:true});",
    "fs.mkdirSync('src/auth',{recursive:true});",
    "fs.mkdirSync('src/worker',{recursive:true});",
    "fs.mkdirSync('migrations',{recursive:true});",
    "fs.mkdirSync('tests',{recursive:true});",
    "fs.writeFileSync('src/http/routes.ts','export const routes=[\\\"POST /requests\\\"];\\n');",
    "fs.writeFileSync('src/services/work-intake.service.ts','export class WorkIntakeService {}\\n');",
    "fs.writeFileSync('src/repositories/work-intake.repository.ts','export interface WorkIntakeRepository { save(): void }\\n');",
    "fs.writeFileSync('src/domain/model.ts','export interface Organization { id: string } export interface Request { organizationId: string }\\n');",
    "fs.writeFileSync('src/auth/policy.ts','export function assertTenantRole() { return true; }\\n');",
    "fs.writeFileSync('src/worker/escalation-digest.worker.ts','export function runDigest() { return true; }\\n');",
    "fs.writeFileSync('migrations/001_initial.sql','create table requests (id text primary key);\\n');",
    "fs.writeFileSync('tests/work-intake.service.test.ts','test(\\\"service\\\", () => true);\\n');",
    `fs.writeFileSync(process.argv[1], JSON.stringify({ task_success: true, quality_score: 100, files_read: 1, provider_total_tokens: 1000 }));`,
    '" {result_file}',
  ].join('');
  const withoutCommand = 'node -e "process.exit(1)"';

  const result = await runLiveAgentPairFromWorkspaces(input, {
    withKlauro: withCommand,
    withoutKlauro: withoutCommand,
    workRoot: path.join(root, 'trials'),
    timeoutMs: 60_000,
  }, {
    withKlauroRepoPath: withBase,
    withoutKlauroRepoPath: withoutBase,
  });

  assert.equal(result.with_klauro.status, 'pass');
  assert.equal(result.without_klauro.status, 'fail');
  assert.equal(result.evaluation.status, 'pass');
  assert.equal(result.status, 'pass');
});

test('greenfield live prompt summarizes validation instead of embedding generated shell validator', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-live-compact-validation-'));
  const withBase = path.join(root, 'with-base');
  const withoutBase = path.join(root, 'without-base');
  await writeFiles(withBase, { 'package.json': '{"type":"module"}' });
  await writeFiles(withoutBase, { 'package.json': '{"type":"module"}' });

  const input = greenfieldInput(
    'greenfield-scratch-build-continuation',
    'Continue the compliance evidence platform with vendor attestations and reviewer queues.'
  );
  input.validationPlan = {
    commands: [{
      command: `node -e '${'x'.repeat(2000)}'`,
    }],
  };
  input.idiomContext = {
    continuation_execution_brief: {
      task: 'Continue compliance evidence',
      read_first: [
        { file: 'src/models/compliance.model.ts' },
        { file: 'src/services/compliance.service.ts' },
        { file: 'src/http/routes.ts' },
        { file: 'src/repositories/compliance.repository.ts' },
        { file: 'tests/compliance.test.ts' },
      ],
      must_represent: ['vendor attestation intake'],
      reuse: ['Reuse EvidenceRequest'],
      boundaries: ['Extend existing service boundary'],
      validation: {
        needs_migration_evidence: true,
        min_focused_tests: 3,
      },
    },
    growth_control_plane: {
      mode: 'cas_backed_growth',
      focus_rule: 'Implement one coherent product behavior by extending owner files.',
      architecture_budget: ['Service Layer', 'Repository/Data Access Boundary'],
      owner_files: [
        { file: 'src/models/compliance.model.ts' },
        { file: 'src/services/compliance.service.ts' },
      ],
      known_concepts: ['Id', 'IsoDate', 'ComplianceProgram', 'EvidenceRequest', 'ControlOwner'],
      duplication_gate: ['Check known_concepts before adding a model or service.'],
      stop_rule: 'Stop after one coherent continuation slice and focused validation.',
    },
  };
  input.fileReadPlan = [
    { file: 'src/models/compliance.model.ts' },
    { file: 'src/services/compliance.service.ts' },
    { file: 'src/http/routes.ts' },
    { file: 'src/repositories/compliance.repository.ts' },
    { file: 'tests/compliance.test.ts' },
    { file: 'package.json' },
    { file: 'tsconfig.json' },
    { file: 'README.md' },
  ];
  const command = [
    'node -e "',
    "const fs=require('fs');",
    `fs.writeFileSync(process.argv[1], JSON.stringify({ task_success: true, quality_score: 95, files_read: 1, provider_total_tokens: 1000 }));`,
    '" {result_file}',
  ].join('');

  const result = await runLiveAgentPairFromWorkspaces(input, {
    withKlauro: command,
    withoutKlauro: command,
    workRoot: path.join(root, 'trials'),
    timeoutMs: 60_000,
  }, {
    withKlauroRepoPath: withBase,
    withoutKlauroRepoPath: withoutBase,
  });

  const prompt = await fs.readFile(result.with_klauro.prompt_file, 'utf8');
  assert.match(prompt, /Klauro validation target:/);
  assert.match(prompt, /Growth control: cas_backed_growth/);
  assert.match(prompt, /Owner files: src\/models\/compliance\.model\.ts, src\/services\/compliance\.service\.ts/);
  assert.match(prompt, /Owned concepts: ComplianceProgram, EvidenceRequest, ControlOwner/);
  assert.doesNotMatch(prompt, /Owned concepts: Id, IsoDate/);
  assert.match(prompt, /Read budget: read only those owner files first/);
  assert.match(prompt, /Edit budget: extend existing domain\/service\/repository\/controller\/test owners/);
  assert.match(prompt, /Duplication gate:/);
  assert.match(prompt, /new continuation migration file under migrations\//);
  assert.match(prompt, /3\+ focused tests\/test cases/);
  assert.match(prompt, /Focused test rule: create or update at least 3 focused continuation tests or test cases/);
  assert.doesNotMatch(prompt, /node -e/);
  assert.match(prompt, /Continuation rule: read the first-read owner files/);
  assert.doesNotMatch(prompt, /package\.json, tsconfig\.json, README\.md/);
  assert.ok(prompt.length < 5000);
});

test('initial greenfield live prompt names migration evidence when required', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-live-initial-validation-prompt-'));
  const withBase = path.join(root, 'with-base');
  const withoutBase = path.join(root, 'without-base');
  await writeFiles(withBase, { 'README.md': 'empty' });
  await writeFiles(withoutBase, { 'README.md': 'empty' });

  const input = greenfieldInput(
    'greenfield-scratch-build',
    'Build a compliance evidence backend with persistence, tests, and migration evidence.'
  );
  input.validationPlan = {
    commands: [{
      command: `node -e '${'x'.repeat(2000)}'`,
    }],
  };
  input.idiomContext = {
    product: 'klauro_greenfield_scratch_build_guidance',
    build_capsule: {
      format: 'G1',
      capsule: 'G1|0|Create one compliance evidence slice\nB|evidence backend with persistence\nP|MVC;Layered Architecture;Repository\nN|src/domain/<model>.ts;src/services/<capability>.ts;migrations/<timestamp>.sql;tests/<capability>.test.ts\nV|migration evidence;2 focused tests\n!|Stop after one coherent slice',
      estimated_tokens: 62,
    },
    validation: {
      needs_migration_evidence: true,
      min_focused_tests: 2,
    },
    recommended_architecture: {
      patterns: [{ name: 'MVC' }, { pattern: 'Layered Architecture' }, 'Repository', 'Service Layer'],
      file_plan: [{ path: 'src/domain/<model>.ts' }, { file: 'src/services/<capability>.ts' }, 'migrations/<timestamp>.sql', 'tests/<capability>.test.ts'],
      architecture_contract: {
        required_boundaries: [
          { kind: 'entry', files: ['src/routes-or-controllers/<capability>.ts'] },
          { kind: 'service', files: ['src/services/<capability>.service.ts'] },
          { kind: 'domain_model', files: ['src/domain/<domain>.models.ts'] },
          { kind: 'repository', files: ['src/repositories/<domain>.repository.ts'] },
          { kind: 'migration', files: ['migrations/<timestamp>_<change>.sql'] },
          { kind: 'auth_policy', files: ['src/auth-or-policies/<scope>.policy.ts'] },
          { kind: 'test', files: ['tests/<capability>.test.ts'] },
        ],
        do_not_collapse: [
          'Do not put business decisions, persistence, billing/webhook handling, or auth/tenant policy directly in route/API files.',
        ],
        minimality_rule: 'Minimize tokens and files by keeping each required boundary small, not by merging boundary responsibilities.',
      },
    },
    growth_control_plane: {
      mode: 'first_slice_bootstrap',
      focus_rule: 'Implement one tested vertical slice; do not create a broad platform skeleton before behavior exists.',
      architecture_budget: ['MVC', 'Layered Architecture', 'Repository'],
      known_concepts: ['ComplianceProgram', 'EvidenceRequest', 'AuditExport'],
      duplication_gate: ['Check known_concepts before adding a model or service.'],
      stop_rule: 'Stop after one coherent slice, focused validation, and a result summary.',
      next_klauro_loop: ['Create the first file bundle.', 'Run preview_greenfield_codebase on the bundle.'],
    },
    model_reuse: ['Define ComplianceProgram and EvidenceRequest once.'],
    boundary_rules: ['Add migrations for persistence changes.'],
    large_scale_build_strategy: {
      core_concepts_to_name_once: ['Build a production', 'Use TypeScript and', 'Compliance Program'],
    },
  };
  const command = [
    'node -e "',
    "const fs=require('fs');",
    `fs.writeFileSync(process.argv[1], JSON.stringify({ task_success: true, quality_score: 95, files_read: [], tests_run: [], provider_total_tokens: 1000 }));`,
    '" {result_file}',
  ].join('');

  const result = await runLiveAgentPairFromWorkspaces(input, {
    withKlauro: command,
    withoutKlauro: command,
    workRoot: path.join(root, 'trials'),
    timeoutMs: 60_000,
  }, {
    withKlauroRepoPath: withBase,
    withoutKlauroRepoPath: withoutBase,
  });

  const prompt = await fs.readFile(result.with_klauro.prompt_file, 'utf8');
  assert.match(prompt, /G1 build capsule:/);
  assert.match(prompt, /G1\|0\|Create one compliance evidence slice/);
  assert.match(prompt, /include migration evidence under migrations\//);
  assert.match(prompt, /Growth control: first_slice_bootstrap/);
  assert.match(prompt, /Architecture budget: MVC, Layered Architecture, Repository\./);
  assert.match(prompt, /Owned concepts: ComplianceProgram, EvidenceRequest, AuditExport\./);
  assert.match(prompt, /Next Klauro loop: Create the first file bundle\. -> Run preview_greenfield_codebase on the bundle\./);
  assert.match(prompt, /2\+ focused tests\/test cases/);
  assert.match(prompt, /Validation target: migration file under migrations\/; 2\+ focused tests\/test cases\./);
  assert.match(prompt, /Focused test rule: create or update at least 2 focused initial tests or test cases/);
  assert.match(prompt, /Architecture pattern: MVC, Layered Architecture, Repository, Service Layer\./);
  assert.match(prompt, /Required boundaries: entry\/API, service\/use-case, domain model, repository\/data, migration, auth\/policy/);
  assert.match(prompt, /Execution rule: create files directly now/);
  assert.match(prompt, /Token rule: smallest coherent vertical slice; save tokens by making each boundary small/);
  assert.doesNotMatch(prompt, /\\[object Object\\]/);
  assert.doesNotMatch(prompt, /Core concepts to name once/);
  assert.doesNotMatch(prompt, /Build a production/);
  assert.doesNotMatch(prompt, /node -e/);
  assert.ok(prompt.length < 4500);
});

test('existing-project live prompt uses compact semantic execution brief', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-live-existing-compact-prompt-'));
  const withBase = path.join(root, 'with-base');
  const withoutBase = path.join(root, 'without-base');
  await writeFiles(withBase, {
    'package.json': '{"type":"module"}',
    'src/auth/authService.ts': 'export class AuthService {}',
    'src/auth/oidcClient.ts': 'export class OidcClient {}',
    'src/auth/sessionRepository.ts': 'export class SessionRepository {}',
    'tests/authService.test.js': 'import assert from "node:assert/strict"; assert.ok(true);',
  });
  await writeFiles(withoutBase, {
    'package.json': '{"type":"module"}',
    'src/auth/authService.ts': 'export class AuthService {}',
  });

  const input: LiveAgentPairInput = {
    repo: 'auth-app',
    repoPath: withBase,
    taskId: 'password-auth-to-oidc-replacement',
    taskLabel: 'Replace password auth with OIDC',
    taskCategory: 'auth-system-replacement',
    task: {
      task_type: 'modify',
      target: 'replace password auth with OIDC',
      instructions: 'Replace local password auth with OIDC without bypassing sessions.',
      success_criteria: ['AuthService uses OidcClient', 'SessionRepository remains unchanged'],
      related_paths: [],
    } as any,
    expectedOutcome: 'OIDC login through AuthService with session boundary preserved.',
    fileReadPlan: [
      { file: 'src/auth/authService.ts' },
      { file: 'src/auth/oidcClient.ts' },
      { file: 'src/auth/sessionRepository.ts' },
      { file: 'tests/authService.test.js' },
    ],
    validationPlan: {
      commands: [{ command: 'node validator.cjs' }],
      expected_changed_files: ['src/auth/authService.ts', 'tests/authService.test.js'],
      semantic_rules: {
        required_changed_files: ['src/auth/authService.ts', 'tests/authService.test.js'],
        forbidden_changed_files: ['src/auth/sessionRepository.ts'],
        required_diff_patterns: ['OidcClient|oidc', 'verifyIdToken', 'createSession'],
        forbidden_diff_patterns: ['passwords\\.verify', 'new SessionRepository\\('],
        require_test_import_source: true,
        max_changed_files: 3,
      },
    },
    idiomContext: {
      task_family: 'auth-system-replacement',
      expected_files: ['src/auth/authService.ts', 'src/auth/oidcClient.ts', 'src/auth/sessionRepository.ts', 'tests/authService.test.js'],
      changed_files: ['src/auth/authService.ts', 'tests/authService.test.js'],
      semantic_rules: {
        required_changed_files: ['src/auth/authService.ts', 'tests/authService.test.js'],
        forbidden_changed_files: ['src/auth/sessionRepository.ts'],
        required_diff_patterns: ['OidcClient|oidc', 'verifyIdToken', 'createSession'],
        forbidden_diff_patterns: ['passwords\\.verify', 'new SessionRepository\\('],
        require_test_import_source: true,
        max_changed_files: 3,
      },
      guidance: ['Keep SessionRepository as the session persistence boundary.'],
    },
  };
  const command = [
    'node -e "',
    "const fs=require('fs');",
    `fs.writeFileSync(process.argv[1], JSON.stringify({ task_success: true, quality_score: 95, files_read: 1, provider_total_tokens: 1000 }));`,
    '" {result_file}',
  ].join('');

  const result = await runLiveAgentPairFromWorkspaces(input, {
    withKlauro: command,
    withoutKlauro: command,
    workRoot: path.join(root, 'trials'),
    timeoutMs: 60_000,
  }, {
    withKlauroRepoPath: withBase,
    withoutKlauroRepoPath: withoutBase,
  });

  const prompt = await fs.readFile(result.with_klauro.prompt_file, 'utf8');
  assert.match(prompt, /Use this Klauro brief as the complete starting context/);
  assert.doesNotMatch(prompt, /Immediately read this precomputed Klauro work packet first/);
  assert.match(prompt, /Read first: src\/auth\/authService\.ts, tests\/authService\.test\.js\./);
  assert.match(prompt, /Edit only when needed: src\/auth\/authService\.ts, tests\/authService\.test\.js\./);
  assert.match(prompt, /Only inspect if needed: src\/auth\/oidcClient\.ts, src\/auth\/sessionRepository\.ts\./);
  assert.match(prompt, /Do not change: src\/auth\/sessionRepository\.ts\./);
  assert.match(prompt, /Required patch evidence:/);
  assert.match(prompt, /OidcClient\|oidc/);
  assert.match(prompt, /Avoid shortcuts:/);
  assert.match(prompt, /passwords\\\.verify/);
  assert.match(prompt, /focused tests must import and exercise production source directly/);
  assert.match(prompt, /do not copy, inline, or fall back to mirrored implementation logic/);
  assert.match(prompt, /Change budget: 3 files maximum\./);
  assert.ok(prompt.length < 3000);
});

test('live prompts omit benchmark bookkeeping files when command does not consume them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-live-no-bookkeeping-prompt-'));
  const withBase = path.join(root, 'with-base');
  const withoutBase = path.join(root, 'without-base');
  await writeFiles(withBase, {
    'package.json': '{"type":"module"}',
    'src/service.ts': 'export const value = 1;',
  });
  await writeFiles(withoutBase, {
    'package.json': '{"type":"module"}',
    'src/service.ts': 'export const value = 1;',
  });

  const input: LiveAgentPairInput = {
    repo: 'service-app',
    repoPath: withBase,
    taskId: 'read-service',
    taskLabel: 'Inspect service',
    taskCategory: 'orientation',
    task: {
      task_type: 'orient',
      target: 'src/service.ts',
      instructions: 'Inspect the service and report readiness.',
      success_criteria: ['No edits required'],
      related_paths: ['src/service.ts'],
    } as any,
    expectedOutcome: 'Service readiness is described.',
    fileReadPlan: [{ file: 'src/service.ts' }],
  };
  const command = [
    'node -e "',
    "console.log(JSON.stringify({usage:{input_tokens:10,output_tokens:2},result:'done'}));",
    '"',
  ].join('');

  const result = await runLiveAgentPairFromWorkspaces(input, {
    withKlauro: command,
    withoutKlauro: command,
    workRoot: path.join(root, 'trials'),
    timeoutMs: 60_000,
  }, {
    withKlauroRepoPath: withBase,
    withoutKlauroRepoPath: withoutBase,
  });

  const withPrompt = await fs.readFile(result.with_klauro.prompt_file, 'utf8');
  const withoutPrompt = await fs.readFile(result.without_klauro.prompt_file, 'utf8');
  assert.match(withPrompt, /Do not create benchmark bookkeeping files/);
  assert.match(withoutPrompt, /Do not create benchmark bookkeeping files/);
  assert.doesNotMatch(withPrompt, /write JSON to/i);
  assert.doesNotMatch(withoutPrompt, /write JSON to/i);
});

test('live runner timeout terminates hung agent commands', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-live-timeout-'));
  const withBase = path.join(root, 'with-base');
  const withoutBase = path.join(root, 'without-base');
  await writeFiles(withBase, { 'package.json': '{"type":"module"}' });
  await writeFiles(withoutBase, { 'package.json': '{"type":"module"}' });

  const input = greenfieldInput('greenfield-timeout-proof', 'Build a tiny proof.');
  const command = 'node -e "setInterval(()=>{}, 1000)"';
  const startedAt = Date.now();
  const result = await runLiveAgentPairFromWorkspaces(input, {
    withKlauro: command,
    withoutKlauro: command,
    workRoot: path.join(root, 'trials'),
    timeoutMs: 250,
  }, {
    withKlauroRepoPath: withBase,
    withoutKlauroRepoPath: withoutBase,
  });

  assert.equal(result.with_klauro.timed_out, true);
  assert.equal(result.without_klauro.timed_out, true);
  assert.ok(Date.now() - startedAt < 10_000);
});

function greenfieldInput(category: string, instructions: string): LiveAgentPairInput {
  return {
    repo: 'scratch',
    repoPath: '/tmp/scratch',
    taskId: category,
    taskLabel: 'Scratch greenfield proof',
    taskCategory: category,
    task: {
      task_type: 'modify',
      target: 'empty folder',
      instructions,
      success_criteria: [],
      related_paths: [],
    } as any,
    expectedOutcome: 'A coherent codebase that can continue growing without rebuilding concepts.',
    fileReadPlan: [],
  };
}

function arm(armName: 'with-klauro' | 'without-klauro', workspace: string, tokens: number): LiveAgentArmResult {
  return {
    attempted: true,
    arm: armName,
    status: 'pass',
    workspace,
    prompt_file: path.join(workspace, 'prompt.md'),
    metrics_file: path.join(workspace, '.metrics.json'),
    result_file: path.join(workspace, '.result.json'),
    diff_file: path.join(workspace, 'diff.patch'),
    duration_ms: armName === 'with-klauro' ? 1000 : 1300,
    files_changed: armName === 'with-klauro' ? 8 : 10,
    changed_files: [],
    lines_added: armName === 'with-klauro' ? 400 : 500,
    lines_deleted: 0,
    command_passed: true,
    validation_passed: true,
    tests_passed: true,
    provider_total_tokens: tokens,
    estimated_input_tokens: 100,
    estimated_output_tokens: 100,
    estimated_total_tokens: 200,
    task_success: true,
    self_reported_quality_score: 95,
  };
}

async function writeFiles(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(root, file);
    await fs.ensureDir(path.dirname(absolute));
    await fs.writeFile(absolute, content, 'utf8');
  }
}
