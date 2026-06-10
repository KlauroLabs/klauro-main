import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { evaluateLivePairDeterministically, runLiveAgentPairFromWorkspaces, type LiveAgentArmResult, type LiveAgentPairInput } from './agent-live-trial';

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
    validation: {
      needs_migration_evidence: true,
      min_focused_tests: 2,
    },
    recommended_architecture: {
      patterns: [{ name: 'MVC' }, { pattern: 'Layered Architecture' }, 'Repository', 'Service Layer'],
      file_plan: [{ path: 'src/domain/<model>.ts' }, { file: 'src/services/<capability>.ts' }, 'migrations/<timestamp>.sql', 'tests/<capability>.test.ts'],
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
  assert.match(prompt, /include migration evidence under migrations\//);
  assert.match(prompt, /Growth control: first_slice_bootstrap/);
  assert.match(prompt, /Architecture budget: MVC, Layered Architecture, Repository\./);
  assert.match(prompt, /Owned concepts: ComplianceProgram, EvidenceRequest, AuditExport\./);
  assert.match(prompt, /Next Klauro loop: Create the first file bundle\. -> Run preview_greenfield_codebase on the bundle\./);
  assert.match(prompt, /2\+ focused tests\/test cases/);
  assert.match(prompt, /Validation target: migration file under migrations\/; 2\+ focused tests\/test cases\./);
  assert.match(prompt, /Focused test rule: create or update at least 2 focused initial tests or test cases/);
  assert.match(prompt, /Architecture pattern: MVC, Layered Architecture, Repository, Service Layer\./);
  assert.match(prompt, /File plan:/);
  assert.doesNotMatch(prompt, /\\[object Object\\]/);
  assert.doesNotMatch(prompt, /Core concepts to name once/);
  assert.doesNotMatch(prompt, /Build a production/);
  assert.doesNotMatch(prompt, /node -e/);
  assert.ok(prompt.length < 4000);
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
  assert.match(prompt, /Read first: src\/auth\/authService\.ts, tests\/authService\.test\.js, src\/auth\/oidcClient\.ts, src\/auth\/sessionRepository\.ts\./);
  assert.match(prompt, /Edit only when needed: src\/auth\/authService\.ts, tests\/authService\.test\.js\./);
  assert.match(prompt, /Do not change: src\/auth\/sessionRepository\.ts\./);
  assert.match(prompt, /Required patch evidence:/);
  assert.match(prompt, /OidcClient\|oidc/);
  assert.match(prompt, /Avoid shortcuts:/);
  assert.match(prompt, /passwords\\\.verify/);
  assert.match(prompt, /Change budget: 3 files maximum\./);
  assert.ok(prompt.length < 3000);
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
