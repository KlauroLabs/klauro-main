#!/usr/bin/env tsx
import * as fs from 'fs-extra';
import * as path from 'path';
import { getAnalysis } from './analyzer';
import { analyzeForBench } from './gauntlet/product-analysis';
import { buildGreenfieldArchitectureGuidance, type GreenfieldReferenceAnalysis } from './greenfield-guidance';
import { runLiveAgentPair, type LiveAgentCommandConfig, type LiveAgentPairResult } from './agent-live-trial';
import { previewGreenfieldCodebase, getPreviewAnalysis, type ProposedFileInput } from './proposal-preview';
import { saveAgenticBenchmarkReport } from './storage';
import { isDirectCliInvocation } from './cli-invocation';
import { defaultBenchmarkReferencePaths } from './benchmark-reference-paths';

interface Scenario {
  id: string;
  title: string;
  plan: string;
  required: {
    api?: boolean;
    ui?: boolean;
    data?: boolean;
    auth?: boolean;
    worker?: boolean;
    external?: boolean;
  };
  baselineFiles: ProposedFileInput[];
  guidedFiles: ProposedFileInput[];
}

interface Args {
  references: string[];
  outputPath: string;
  markdownPath: string;
  liveRequested: boolean;
  commands: LiveAgentCommandConfig;
}

export async function runAgentGreenfieldBenchmark(args: Partial<Args> = {}) {
  const parsed = {
    references: args.references || defaultReferencePaths(),
    outputPath: args.outputPath || path.join(process.cwd(), '.klauro-agent-greenfield-benchmark', 'latest-report.json'),
    markdownPath: args.markdownPath || path.join(process.cwd(), '.klauro-agent-greenfield-benchmark', 'latest-report.md'),
    liveRequested: args.liveRequested || false,
    commands: args.commands || {},
  };
  if (parsed.liveRequested && !(parsed.commands.withKlauro && parsed.commands.withoutKlauro)) {
    throw new Error('Live greenfield benchmark requires --agent-with-cmd and --agent-without-cmd');
  }
  const references = await loadReferences(parsed.references);
  const scenarios = buildScenarios();
  const results = [];
  const continuityTrials = [];
  let liveTasksStarted = 0;

  for (const scenario of scenarios) {
    const guidance = buildGreenfieldArchitectureGuidance({
      planText: scenario.plan,
      proposedFiles: scenario.guidedFiles,
      references,
    });
    const baselinePreview = await previewGreenfieldCodebase({
      title: `${scenario.title} baseline`,
      planText: scenario.plan,
      proposedFiles: scenario.baselineFiles,
      previewBaseUrl: 'https://app.klauro.test',
    }) as any;
    const guidedPreview = await previewGreenfieldCodebase({
      title: `${scenario.title} with Klauro`,
      planText: scenario.plan,
      proposedFiles: scenario.guidedFiles,
      previewBaseUrl: 'https://app.klauro.test',
    }) as any;
    const baselinePayload = await getPreviewAnalysis(baselinePreview.preview.id);
    const guidedPayload = await getPreviewAnalysis(guidedPreview.preview.id);
    const baselineScore = scoreGreenfieldBundle(scenario, scenario.baselineFiles, baselinePayload.proposed_cas as any, null);
    const guidedScore = scoreGreenfieldBundle(scenario, scenario.guidedFiles, guidedPayload.proposed_cas as any, guidance);
    const delta = guidedScore.score - baselineScore.score;

    results.push({
      id: scenario.id,
      title: scenario.title,
      status: delta > 0 && guidedPreview.visualization_summary?.proposed_nodes > 0 ? 'pass' : 'fail',
      score_delta: delta,
      baseline: {
        score: baselineScore.score,
        findings: baselineScore.findings,
        preview_id: baselinePreview.preview.id,
        preview_url: baselinePreview.preview.preview_url,
        nodes: baselinePreview.visualization_summary?.proposed_nodes || 0,
        edges: baselinePreview.visualization_summary?.proposed_edges || 0,
      },
      with_klauro: {
        score: guidedScore.score,
        findings: guidedScore.findings,
        guidance_status: guidance.status,
        overlap_status: guidance.existing_overlap.status,
        overlap_matches: guidance.existing_overlap.matches.length,
        recommended_patterns: guidance.recommended_architecture.patterns.map(pattern => pattern.name),
        preview_id: guidedPreview.preview.id,
        preview_url: guidedPreview.preview.preview_url,
        nodes: guidedPreview.visualization_summary?.proposed_nodes || 0,
        edges: guidedPreview.visualization_summary?.proposed_edges || 0,
      },
    });

    const result = results[results.length - 1] as any;
    const maxLiveTasks = parsed.commands.maxLiveTasks;
    if (parsed.liveRequested &&
      liveTaskAllowed(parsed.commands, scenario.id, 'greenfield-build') &&
      (maxLiveTasks === undefined || liveTasksStarted < maxLiveTasks)) {
      liveTasksStarted++;
      result.live_pair = await runLiveGreenfieldScenario(scenario, guidance, parsed.commands);
      result.live_greenfield = await scoreLiveGreenfieldScenario(scenario, result.live_pair, guidance);
      if (result.live_greenfield.status === 'fail') result.status = 'fail';
    }
  }

  const hasContinuityLiveFilter = (parsed.commands.liveTaskCategories || [])
    .some(category => category.includes('continuity'));
  const continuityCommands = parsed.liveRequested &&
    (parsed.commands.maxLiveTasks === undefined || hasContinuityLiveFilter)
    ? parsed.commands
    : undefined;
  continuityTrials.push(await runGreenfieldContinuityTrial(
    references,
    continuityCommands
  ));
  continuityTrials.push(await runMassiveGreenfieldContinuityTrial(references, continuityCommands));

  const report = {
    id: `agent-greenfield-benchmark-${Date.now()}`,
    benchmark_type: 'agent-greenfield-benchmark',
    generated_at: new Date().toISOString(),
    status: results.every(result => result.status === 'pass') && continuityTrials.every(trial => trial.status === 'pass') ? 'pass' : 'fail',
    score: Math.round(results.reduce((sum, result) => sum + Math.max(0, Math.min(100, 50 + result.score_delta)), 0) / Math.max(1, results.length)),
    reference_count: references.length,
    summary: {
      proof_strength: results.some((result: any) => result.live_pair) || continuityTrials.some((trial: any) => trial.live_pair)
        ? 'live-agent-proof'
        : 'deterministic-proxy',
      claim_limit: results.some((result: any) => result.live_pair) || continuityTrials.some((trial: any) => trial.live_pair)
        ? 'Includes live greenfield/continuity trials for covered scenarios; quality/token claims may cite live deltas.'
        : 'Deterministic proxy only; proves architecture guidance, preview analysis, reuse memory, and continuity scoring, but not final live-agent build quality.',
      token_savings_status: liveTokenSavingsStatus(results, continuityTrials),
      token_savings_claim: liveTokenSavingsClaim(results, continuityTrials),
      scenario_count: results.length,
      average_quality_delta: Math.round(results.reduce((sum, result) => sum + result.score_delta, 0) / Math.max(1, results.length)),
      scenarios_improved: results.filter(result => result.score_delta > 0).length,
      preview_successes: results.filter(result => result.with_klauro.nodes > 0).length,
      live_trials_attempted: results.filter((result: any) => result.live_pair).length,
      live_average_quality_delta: average(results
        .map((result: any) => conservativeLiveQualityDelta(result.live_greenfield, result.live_pair))
        .filter((value: unknown): value is number => typeof value === 'number')),
      live_average_token_reduction: average(results
        .map((result: any) => result.live_pair?.evaluation?.token_reduction_percentage)
        .filter((value: unknown): value is number => typeof value === 'number')),
      live_average_time_reduction: average(results
        .map((result: any) => result.live_pair?.evaluation?.time_reduction_percentage)
        .filter((value: unknown): value is number => typeof value === 'number')),
      continuity_trial_count: continuityTrials.length,
      continuity_trials_passed: continuityTrials.filter(trial => trial.status === 'pass').length,
      continuity_average_delta: average(continuityTrials.map(trial => trial.score_delta)),
      live_continuity_trials_attempted: continuityTrials.filter((trial: any) => trial.live_pair).length,
      live_continuity_trials_passed: continuityTrials.filter((trial: any) => trial.live_continuity?.status === 'pass').length,
      live_continuity_average_delta: average(continuityTrials
        .map((trial: any) => conservativeLiveQualityDelta(trial.live_continuity, trial.live_pair))
        .filter((value: unknown): value is number => typeof value === 'number')),
      live_continuity_average_token_reduction: average(continuityTrials
        .map((trial: any) => trial.live_pair?.evaluation?.token_reduction_percentage)
        .filter((value: unknown): value is number => typeof value === 'number')),
      live_continuity_average_time_reduction: average(continuityTrials
        .map((trial: any) => trial.live_pair?.evaluation?.time_reduction_percentage)
        .filter((value: unknown): value is number => typeof value === 'number')),
    },
    results,
    continuity_trials: continuityTrials,
  };
  await fs.ensureDir(path.dirname(parsed.outputPath));
  await fs.writeJson(parsed.outputPath, report, { spaces: 2 });
  await fs.ensureDir(path.dirname(parsed.markdownPath));
  await fs.writeFile(parsed.markdownPath, formatGreenfieldBenchmarkMarkdown(report), 'utf8');
  await saveAgenticBenchmarkReport(report);
  return report;
}

async function runLiveGreenfieldScenario(
  scenario: Scenario,
  guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance>,
  commands: LiveAgentCommandConfig
): Promise<LiveAgentPairResult> {
  const starter = await createGreenfieldStarterRepo(scenario);
  return runLiveAgentPair({
    repo: `greenfield-${scenario.id}`,
    repoPath: starter,
    taskId: `greenfield-${scenario.id}`,
    taskLabel: scenario.title,
    taskCategory: 'greenfield-build',
    task: {
      task_type: 'modify',
      target: 'new codebase',
      instructions: [
        scenario.plan,
        'Create the minimal production-shaped project files needed to satisfy the plan.',
        'Avoid duplicate concepts, mixed boundaries, and one-file implementations when the requested system has API/data/UI/worker layers.',
        'Write task_success and quality_score into the result JSON when finished.',
      ].join(' '),
      success_criteria: [
        'Creates a coherent source tree with clear entry, behavior, and data/test boundaries where required.',
        'Does not duplicate existing analyzed capabilities without explicitly integrating or naming the overlap.',
        'Includes focused tests or test scaffolding for the highest-risk behavior.',
      ],
      related_paths: [],
    } as any,
    expectedOutcome: 'A coherent greenfield codebase skeleton that Klauro can analyze as normal CAS.',
    fileReadPlan: [],
    selectedNode: null,
    validationPlan: { commands: [] },
    idiomContext: {
      product: 'klauro_greenfield_guidance',
      plan_intent: guidance.plan_intent,
      existing_overlap: guidance.existing_overlap,
      recommended_architecture: guidance.recommended_architecture,
      risks: guidance.risks,
    },
  }, commands);
}

async function createGreenfieldStarterRepo(scenario: Scenario): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.env.HOME || '/tmp', '.klauro-greenfield-live-starter-'));
  await fs.writeFile(path.join(root, 'README.md'), [
    `# ${scenario.title}`,
    '',
    scenario.plan,
    '',
    'This starter repository is intentionally minimal. Build the proposed project files in this workspace.',
    '',
  ].join('\n'), 'utf8');
  return root;
}

async function scoreLiveGreenfieldScenario(
  scenario: Scenario,
  livePair: LiveAgentPairResult,
  guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance>
) {
  const withFiles = await filesFromWorkspace(livePair.with_klauro.workspace);
  const withoutFiles = await filesFromWorkspace(livePair.without_klauro.workspace);
  const withPreview = withFiles.length ? await previewGreenfieldCodebase({
    title: `${scenario.title} live with Klauro`,
    planText: scenario.plan,
    proposedFiles: withFiles,
    previewBaseUrl: 'https://app.klauro.test',
  }) as any : null;
  const withoutPreview = withoutFiles.length ? await previewGreenfieldCodebase({
    title: `${scenario.title} live without Klauro`,
    planText: scenario.plan,
    proposedFiles: withoutFiles,
    previewBaseUrl: 'https://app.klauro.test',
  }) as any : null;
  const withPayload = withPreview?.preview?.id ? await getPreviewAnalysis(withPreview.preview.id) : null;
  const withoutPayload = withoutPreview?.preview?.id ? await getPreviewAnalysis(withoutPreview.preview.id) : null;
  const withScore = scoreGreenfieldBundle(scenario, withFiles, withPayload?.proposed_cas as any, guidance);
  const withoutScore = scoreGreenfieldBundle(scenario, withoutFiles, withoutPayload?.proposed_cas as any, null);
  const qualityDelta = withScore.score - withoutScore.score;
  const evaluatorQualityDelta = livePair.evaluation.quality_score_delta;
  const evaluatorArchitectureDelta = livePair.evaluation.architecture_score_delta;
  const evaluatorAgrees = evaluatorQualityDelta >= 0 &&
    (typeof evaluatorArchitectureDelta !== 'number' || evaluatorArchitectureDelta >= 0);

  return {
    status: liveProofAccepted(livePair, withScore.score, withoutScore.score, evaluatorAgrees) ? 'pass' : 'fail',
    status_reason: liveStatusReason(livePair),
    baseline_completed: livePair.without_klauro.command_passed === true,
    with_score: withScore.score,
    without_score: withoutScore.score,
    quality_delta: qualityDelta,
    evaluator_quality_delta: evaluatorQualityDelta,
    evaluator_architecture_delta: evaluatorArchitectureDelta,
    with_findings: withScore.findings,
    without_findings: withoutScore.findings,
    with_preview_id: withPreview?.preview?.id,
    without_preview_id: withoutPreview?.preview?.id,
    with_file_count: withFiles.length,
    without_file_count: withoutFiles.length,
  };
}

async function runGreenfieldContinuityTrial(
  references: GreenfieldReferenceAnalysis[],
  commands?: LiveAgentCommandConfig
) {
  const sliceOnePlan = [
    'Build the first slice of a tenant-aware project management system.',
    'It needs users, workspaces, projects, authentication boundaries, project listing routes, and tests.',
  ].join(' ');
  const sliceOneFiles: ProposedFileInput[] = [
    { path: 'package.json', content: JSON.stringify({ dependencies: { express: '^4.18.0' }, devDependencies: { jest: '^29.0.0' } }, null, 2) },
    { path: 'src/routes/project.routes.ts', content: "import express from 'express';\nimport { ProjectService } from '../services/project.service';\nexport const projectRouter = express.Router();\nprojectRouter.get('/workspaces/:workspaceId/projects', async (req, res) => res.json(await new ProjectService().listForWorkspace(req.params.workspaceId, req.user?.id)));\n" },
    { path: 'src/services/project.service.ts', content: "import { ProjectRepository } from '../repositories/project.repository';\nexport class ProjectService {\n  async listForWorkspace(workspaceId: string, userId?: string) {\n    return new ProjectRepository().listForWorkspace(workspaceId, userId);\n  }\n}\n" },
    { path: 'src/repositories/project.repository.ts', content: "export class ProjectRepository {\n  async listForWorkspace(workspaceId: string, userId?: string) { return [{ id: 'project-1', workspaceId, userId }]; }\n}\n" },
    { path: 'src/models/user.ts', content: 'export interface User { id: string; email: string; workspaceIds: string[]; }\n' },
    { path: 'src/models/workspace.ts', content: 'export interface Workspace { id: string; slug: string; ownerUserId: string; }\n' },
    { path: 'src/models/project.ts', content: 'export interface Project { id: string; workspaceId: string; name: string; }\n' },
    { path: 'src/auth/workspace-scope.guard.ts', content: 'export function assertWorkspaceScope(user: { workspaceIds: string[] }, workspaceId: string) { if (!user.workspaceIds.includes(workspaceId)) throw new Error("Forbidden"); }\n' },
    { path: 'migrations/001_create_workspace_projects.sql', content: 'CREATE TABLE workspaces (id text primary key, slug text not null); CREATE TABLE projects (id text primary key, workspace_id text not null references workspaces(id));\n' },
    { path: 'tests/project.service.test.ts', content: "import { ProjectService } from '../src/services/project.service';\ntest('lists workspace projects through the existing project service', async () => { await expect(new ProjectService().listForWorkspace('w1', 'u1')).resolves.toHaveLength(1); });\n" },
  ];
  const sliceOnePreview = await previewGreenfieldCodebase({
    title: 'Continuity slice one',
    planText: sliceOnePlan,
    proposedFiles: sliceOneFiles,
    previewBaseUrl: 'https://app.klauro.test',
  }) as any;
  const sliceOnePayload = await getPreviewAnalysis(sliceOnePreview.preview.id);
  const sliceOneReference: GreenfieldReferenceAnalysis = {
    path: `preview:${sliceOnePreview.preview.id}`,
    name: 'continuity-slice-one',
    cas: sliceOnePayload.proposed_cas as any,
  };

  const sliceTwoPlan = [
    'Add project activity audit events and workspace-scoped notification settings.',
    'Do not rebuild users, workspaces, projects, auth, or the project listing capability from the first slice.',
    'Extend the existing project service and model boundaries where possible.',
  ].join(' ');
  const sliceTwoUserRequest = 'Add project activity audit events and workspace-scoped notification settings to the existing project management codebase.';
  const baselineFiles: ProposedFileInput[] = [
    ...sliceOneFiles,
    { path: 'src/activity/User.ts', content: 'export interface User { id: string; email: string; }\n' },
    { path: 'src/activity/Workspace.ts', content: 'export interface Workspace { id: string; name: string; }\n' },
    { path: 'src/activity/Project.ts', content: 'export interface Project { id: string; title: string; }\n' },
    { path: 'src/activity/project-activity.service.ts', content: "export class ProjectActivityService { async record(projectId: string) { return { projectId, status: 'recorded' }; } }\n" },
    { path: 'src/activity/project.routes.ts', content: "import express from 'express';\nexport const activityProjectRouter = express.Router();\nactivityProjectRouter.post('/projects/:projectId/activity', async (req, res) => res.json({ projectId: req.params.projectId }));\n" },
  ];
  const guidedFiles: ProposedFileInput[] = [
    ...sliceOneFiles,
    { path: 'src/models/project-activity.ts', content: "import type { Project } from './project';\nexport interface ProjectActivity { id: string; projectId: Project['id']; actorUserId: string; event: string; }\n" },
    { path: 'src/models/workspace-notification-setting.ts', content: "import type { Workspace } from './workspace';\nexport interface WorkspaceNotificationSetting { id: string; workspaceId: Workspace['id']; channel: 'email' | 'webhook'; enabled: boolean; }\n" },
    { path: 'src/services/project-activity.service.ts', content: "import { ProjectService } from './project.service';\nexport class ProjectActivityService {\n  async recordForProject(workspaceId: string, projectId: string, actorUserId: string) {\n    await new ProjectService().listForWorkspace(workspaceId, actorUserId);\n    return { projectId, actorUserId, status: 'recorded' };\n  }\n}\n" },
    { path: 'src/routes/project-activity.routes.ts', content: "import express from 'express';\nimport { ProjectActivityService } from '../services/project-activity.service';\nexport const projectActivityRouter = express.Router();\nprojectActivityRouter.post('/workspaces/:workspaceId/projects/:projectId/activity', async (req, res) => res.json(await new ProjectActivityService().recordForProject(req.params.workspaceId, req.params.projectId, req.user?.id)));\n" },
    { path: 'src/repositories/workspace-notification-setting.repository.ts', content: "export class WorkspaceNotificationSettingRepository { async findForWorkspace(workspaceId: string) { return [{ workspaceId, channel: 'email', enabled: true }]; } }\n" },
    { path: 'migrations/002_create_project_activity.sql', content: 'CREATE TABLE project_activity (id text primary key, project_id text not null references projects(id), actor_user_id text not null, event text not null);\nCREATE TABLE workspace_notification_settings (id text primary key, workspace_id text not null references workspaces(id), channel text not null, enabled boolean not null);\n' },
    { path: 'tests/project-activity.service.test.ts', content: "import { ProjectActivityService } from '../src/services/project-activity.service';\ntest('records activity through existing workspace/project boundary', async () => { await expect(new ProjectActivityService().recordForProject('w1', 'p1', 'u1')).resolves.toMatchObject({ status: 'recorded' }); });\n" },
  ];
  const guidance = buildGreenfieldArchitectureGuidance({
    planText: sliceTwoPlan,
    proposedFiles: guidedFiles,
    references: [sliceOneReference, ...references],
  });
  const baselinePreview = await previewGreenfieldCodebase({
    title: 'Continuity slice two baseline',
    planText: sliceTwoPlan,
    proposedFiles: baselineFiles,
    previewBaseUrl: 'https://app.klauro.test',
  }) as any;
  const guidedPreview = await previewGreenfieldCodebase({
    title: 'Continuity slice two with Klauro',
    planText: sliceTwoPlan,
    proposedFiles: guidedFiles,
    previewBaseUrl: 'https://app.klauro.test',
  }) as any;
  const baselinePayload = await getPreviewAnalysis(baselinePreview.preview.id);
  const guidedPayload = await getPreviewAnalysis(guidedPreview.preview.id);
  const baselineScore = scoreGreenfieldContinuityBundle(baselineFiles, baselinePayload.proposed_cas as any, null);
  const guidedScore = scoreGreenfieldContinuityBundle(guidedFiles, guidedPayload.proposed_cas as any, guidance);
  const scoreDelta = guidedScore.score - baselineScore.score;

  const trial: any = {
    id: 'greenfield-continuity-project-management',
    title: 'Greenfield continuity across slices',
    status: scoreDelta > 0 && guidedScore.score >= 85 && guidance.capability_memory.reuse_decisions_required.length > 0 ? 'pass' : 'fail',
    score_delta: scoreDelta,
    slice_one: {
      preview_id: sliceOnePreview.preview.id,
      preview_url: sliceOnePreview.preview.preview_url,
      nodes: sliceOnePreview.visualization_summary?.proposed_nodes || 0,
      edges: sliceOnePreview.visualization_summary?.proposed_edges || 0,
    },
    baseline: {
      score: baselineScore.score,
      findings: baselineScore.findings,
      preview_id: baselinePreview.preview.id,
      preview_url: baselinePreview.preview.preview_url,
    },
    with_klauro: {
      score: guidedScore.score,
      findings: guidedScore.findings,
      preview_id: guidedPreview.preview.id,
      preview_url: guidedPreview.preview.preview_url,
      reuse_decisions_required: guidance.capability_memory.reuse_decisions_required,
      do_not_rebuild: guidance.capability_memory.do_not_rebuild,
    },
  };

  if (commands?.withKlauro && commands?.withoutKlauro && liveCategoryAllowed(commands, 'greenfield-continuation')) {
    trial.live_pair = await runLiveGreenfieldContinuityScenario(sliceOneFiles, sliceTwoUserRequest, guidance, commands);
    trial.live_continuity = await scoreLiveGreenfieldContinuityTrial(trial.live_pair, guidance);
    if (trial.live_continuity.status === 'fail') {
      trial.status = 'fail';
    }
  }

  return trial;
}

async function runMassiveGreenfieldContinuityTrial(
  references: GreenfieldReferenceAnalysis[],
  commands?: LiveAgentCommandConfig
) {
  const sliceOnePlan = [
    'Build the first slice of a multi-tenant work platform.',
    'It needs organizations, members, projects, tasks, role-scoped access, project routes, persistence, and tests.',
  ].join(' ');
  const sliceOneFiles: ProposedFileInput[] = [
    { path: 'package.json', content: JSON.stringify({ dependencies: { express: '^4.18.0' }, devDependencies: { jest: '^29.0.0' } }, null, 2) },
    { path: 'src/routes/project.routes.ts', content: "import express from 'express';\nimport { ProjectService } from '../services/project.service';\nexport const projectRouter = express.Router();\nprojectRouter.get('/organizations/:organizationId/projects', async (req, res) => res.json(await new ProjectService().listForOrganization(req.params.organizationId, req.user?.id)));\n" },
    { path: 'src/routes/task.routes.ts', content: "import express from 'express';\nimport { TaskService } from '../services/task.service';\nexport const taskRouter = express.Router();\ntaskRouter.get('/organizations/:organizationId/projects/:projectId/tasks', async (req, res) => res.json(await new TaskService().listForProject(req.params.organizationId, req.params.projectId, req.user?.id)));\n" },
    { path: 'src/services/project.service.ts', content: "import { ProjectRepository } from '../repositories/project.repository';\nimport { assertOrganizationRole } from '../auth/organization-role.guard';\nexport class ProjectService {\n  async listForOrganization(organizationId: string, userId?: string) {\n    assertOrganizationRole(userId, organizationId);\n    return new ProjectRepository().listForOrganization(organizationId);\n  }\n}\n" },
    { path: 'src/services/task.service.ts', content: "import { TaskRepository } from '../repositories/task.repository';\nimport { assertOrganizationRole } from '../auth/organization-role.guard';\nexport class TaskService {\n  async listForProject(organizationId: string, projectId: string, userId?: string) {\n    assertOrganizationRole(userId, organizationId);\n    return new TaskRepository().listForProject(projectId);\n  }\n}\n" },
    { path: 'src/repositories/project.repository.ts', content: "export class ProjectRepository { async listForOrganization(organizationId: string) { return [{ id: 'p1', organizationId, name: 'Launch' }]; } }\n" },
    { path: 'src/repositories/task.repository.ts', content: "export class TaskRepository { async listForProject(projectId: string) { return [{ id: 't1', projectId, title: 'Plan' }]; } }\n" },
    { path: 'src/models/organization.ts', content: 'export interface Organization { id: string; slug: string; name: string; }\n' },
    { path: 'src/models/member.ts', content: "export interface Member { id: string; organizationId: string; userId: string; role: 'owner' | 'admin' | 'member'; }\n" },
    { path: 'src/models/project.ts', content: 'export interface Project { id: string; organizationId: string; name: string; }\n' },
    { path: 'src/models/task.ts', content: "export interface Task { id: string; projectId: string; title: string; status: 'open' | 'done'; }\n" },
    { path: 'src/auth/organization-role.guard.ts', content: "export function assertOrganizationRole(userId: string | undefined, organizationId: string) { if (!userId || !organizationId) throw new Error('Forbidden'); }\n" },
    { path: 'migrations/001_create_work_platform.sql', content: 'CREATE TABLE organizations (id text primary key, slug text not null, name text not null); CREATE TABLE members (id text primary key, organization_id text not null references organizations(id), user_id text not null, role text not null); CREATE TABLE projects (id text primary key, organization_id text not null references organizations(id), name text not null); CREATE TABLE tasks (id text primary key, project_id text not null references projects(id), title text not null, status text not null);\n' },
    { path: 'tests/task.service.test.ts', content: "import { TaskService } from '../src/services/task.service';\ntest('lists tasks through organization-scoped project boundary', async () => { await expect(new TaskService().listForProject('org1', 'p1', 'u1')).resolves.toHaveLength(1); });\n" },
  ];
  const sliceOnePreview = await previewGreenfieldCodebase({
    title: 'Massive continuity slice one',
    planText: sliceOnePlan,
    proposedFiles: sliceOneFiles,
    previewBaseUrl: 'https://app.klauro.test',
  }) as any;
  const sliceOnePayload = await getPreviewAnalysis(sliceOnePreview.preview.id);
  const sliceOneReference: GreenfieldReferenceAnalysis = {
    path: `preview:${sliceOnePreview.preview.id}`,
    name: 'massive-continuity-slice-one',
    cas: sliceOnePayload.proposed_cas as any,
  };

  const finalPlan = [
    'Continue the existing multi-tenant work platform with comments, attachments, audit trail, notifications, saved views, and weekly digest jobs.',
    'Do not rebuild organizations, members, projects, tasks, role guards, project/task routes, repositories, or the first migration.',
    'Extend the existing organization/project/task boundaries and keep migrations/tests incremental.',
  ].join(' ');
  const baselineFiles: ProposedFileInput[] = [
    ...sliceOneFiles,
    { path: 'src/collaboration/Organization.ts', content: 'export interface Organization { id: string; title: string; }\n' },
    { path: 'src/collaboration/Project.ts', content: 'export interface Project { id: string; title: string; }\n' },
    { path: 'src/collaboration/Task.ts', content: 'export interface Task { id: string; body: string; }\n' },
    { path: 'src/collaboration/project.routes.ts', content: "import express from 'express';\nexport const collaborationProjectRouter = express.Router();\ncollaborationProjectRouter.post('/projects/:projectId/comments', async (req, res) => res.json({ projectId: req.params.projectId }));\n" },
    { path: 'src/collaboration/comment.service.ts', content: "export class CommentService { async add(projectId: string) { return { projectId, ok: true }; } }\n" },
    { path: 'src/reports/DigestProject.ts', content: 'export interface DigestProject { id: string; name: string; }\n' },
    { path: 'src/reports/digest.worker.ts', content: "export async function runDigest() { return [{ duplicatedProject: true }]; }\n" },
  ];
  const guidedFiles: ProposedFileInput[] = [
    ...sliceOneFiles,
    { path: 'src/models/comment.ts', content: "import type { Task } from './task';\nexport interface Comment { id: string; taskId: Task['id']; authorMemberId: string; body: string; }\n" },
    { path: 'src/models/attachment.ts', content: "import type { Task } from './task';\nexport interface Attachment { id: string; taskId: Task['id']; uploadedByMemberId: string; url: string; }\n" },
    { path: 'src/models/saved-view.ts', content: "import type { Organization } from './organization';\nexport interface SavedView { id: string; organizationId: Organization['id']; name: string; filters: Record<string, unknown>; }\n" },
    { path: 'src/services/comment.service.ts', content: "import { TaskService } from './task.service';\nexport class CommentService {\n  async addToTask(organizationId: string, projectId: string, taskId: string, userId: string) {\n    await new TaskService().listForProject(organizationId, projectId, userId);\n    return { taskId, status: 'created' };\n  }\n}\n" },
    { path: 'src/services/saved-view.service.ts', content: "import { ProjectService } from './project.service';\nexport class SavedViewService {\n  async listForOrganization(organizationId: string, userId: string) {\n    await new ProjectService().listForOrganization(organizationId, userId);\n    return [{ organizationId, name: 'My work' }];\n  }\n}\n" },
    { path: 'src/routes/comment.routes.ts', content: "import express from 'express';\nimport { CommentService } from '../services/comment.service';\nexport const commentRouter = express.Router();\ncommentRouter.post('/organizations/:organizationId/projects/:projectId/tasks/:taskId/comments', async (req, res) => res.json(await new CommentService().addToTask(req.params.organizationId, req.params.projectId, req.params.taskId, req.user?.id)));\n" },
    { path: 'src/workers/weekly-digest.worker.ts', content: "import { SavedViewService } from '../services/saved-view.service';\nexport async function runWeeklyDigest(organizationId: string, userId: string) { return new SavedViewService().listForOrganization(organizationId, userId); }\n" },
    { path: 'migrations/002_create_collaboration.sql', content: 'CREATE TABLE comments (id text primary key, task_id text not null references tasks(id), author_member_id text not null references members(id), body text not null); CREATE TABLE attachments (id text primary key, task_id text not null references tasks(id), uploaded_by_member_id text not null references members(id), url text not null); CREATE TABLE saved_views (id text primary key, organization_id text not null references organizations(id), name text not null, filters jsonb not null);\n' },
    { path: 'tests/comment.service.test.ts', content: "import { CommentService } from '../src/services/comment.service';\ntest('adds comments through existing organization/project/task scope', async () => { await expect(new CommentService().addToTask('org1', 'p1', 't1', 'u1')).resolves.toMatchObject({ status: 'created' }); });\n" },
    { path: 'tests/weekly-digest.worker.test.ts', content: "import { runWeeklyDigest } from '../src/workers/weekly-digest.worker';\ntest('builds digest from existing organization saved views', async () => { await expect(runWeeklyDigest('org1', 'u1')).resolves.toHaveLength(1); });\n" },
  ];
  const guidance = buildGreenfieldArchitectureGuidance({
    planText: finalPlan,
    proposedFiles: guidedFiles,
    references: [sliceOneReference, ...references],
  });
  const baselinePreview = await previewGreenfieldCodebase({
    title: 'Massive continuity baseline',
    planText: finalPlan,
    proposedFiles: baselineFiles,
    previewBaseUrl: 'https://app.klauro.test',
  }) as any;
  const guidedPreview = await previewGreenfieldCodebase({
    title: 'Massive continuity with Klauro',
    planText: finalPlan,
    proposedFiles: guidedFiles,
    previewBaseUrl: 'https://app.klauro.test',
  }) as any;
  const baselinePayload = await getPreviewAnalysis(baselinePreview.preview.id);
  const guidedPayload = await getPreviewAnalysis(guidedPreview.preview.id);
  const baselineScore = scoreMassiveGreenfieldContinuityBundle(baselineFiles, baselinePayload.proposed_cas as any, null);
  const guidedScore = scoreMassiveGreenfieldContinuityBundle(guidedFiles, guidedPayload.proposed_cas as any, guidance);
  const scoreDelta = guidedScore.score - baselineScore.score;

  const trial: any = {
    id: 'greenfield-continuity-massive-work-platform',
    title: 'Greenfield continuity for a growing work platform',
    status: scoreDelta > 0 && guidedScore.score >= 88 && guidance.capability_memory.reuse_decisions_required.length > 0 ? 'pass' : 'fail',
    score_delta: scoreDelta,
    slice_one: {
      preview_id: sliceOnePreview.preview.id,
      preview_url: sliceOnePreview.preview.preview_url,
      nodes: sliceOnePreview.visualization_summary?.proposed_nodes || 0,
      edges: sliceOnePreview.visualization_summary?.proposed_edges || 0,
    },
    baseline: {
      score: baselineScore.score,
      findings: baselineScore.findings,
      preview_id: baselinePreview.preview.id,
      preview_url: baselinePreview.preview.preview_url,
    },
    with_klauro: {
      score: guidedScore.score,
      findings: guidedScore.findings,
      preview_id: guidedPreview.preview.id,
      preview_url: guidedPreview.preview.preview_url,
      reuse_decisions_required: guidance.capability_memory.reuse_decisions_required,
      do_not_rebuild: guidance.capability_memory.do_not_rebuild,
    },
  };

  if (commands?.withKlauro && commands?.withoutKlauro && liveCategoryAllowed(commands, 'greenfield-continuity-massive')) {
    trial.live_pair = await runLiveMassiveGreenfieldContinuityScenario(sliceOneFiles, finalPlan, guidance, commands);
    trial.live_continuity = await scoreLiveMassiveGreenfieldContinuityTrial(trial.live_pair, finalPlan, guidance);
    if (trial.live_continuity.status === 'fail') {
      trial.status = 'fail';
    }
  }

  return trial;
}

async function runLiveGreenfieldContinuityScenario(
  sliceOneFiles: ProposedFileInput[],
  sliceTwoPlan: string,
  guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance>,
  commands: LiveAgentCommandConfig
): Promise<LiveAgentPairResult> {
  const starter = await createStarterRepoFromFiles('continuity-project-management', sliceOneFiles, [
    '# Continuity Project Management',
    '',
    'Slice one already implemented users, workspaces, projects, workspace-scoped project listing, auth scope, a migration, and a focused service test.',
    '',
  ].join('\n'));

  return runLiveAgentPair({
    repo: 'greenfield-continuity-project-management',
    repoPath: starter,
    taskId: 'greenfield-continuity-project-management',
    taskLabel: 'Add project activity and workspace notification settings',
    taskCategory: 'greenfield-continuation',
    task: {
      task_type: 'modify',
      target: 'existing slice-one project management codebase',
      instructions: [
        sliceTwoPlan,
        'This is a continuation of an existing codebase, not a clean-slate build.',
        'Add persistence evidence and a focused test for the new behavior.',
        'Write task_success and quality_score into the result JSON when finished.',
      ].join(' '),
      success_criteria: [
        'Project activity audit events can be recorded.',
        'Workspace notification settings can be stored or retrieved.',
        'Persistence changes are represented.',
        'A focused test or test scaffold covers the new slice.',
      ],
      related_paths: [
        'src/models/project.ts',
        'src/models/workspace.ts',
        'src/services/project.service.ts',
        'src/routes/project.routes.ts',
        'migrations/001_create_workspace_projects.sql',
        'tests/project.service.test.ts',
      ],
    } as any,
    expectedOutcome: 'A slice-two continuation that adds project activity and notification settings to the existing project management codebase.',
    fileReadPlan: [
      { file: 'src/services/project.service.ts', reason: 'Existing project service boundary to extend or verify through.' },
      { file: 'src/models/project.ts', reason: 'Existing project model that should be reused rather than duplicated.' },
      { file: 'src/routes/project.routes.ts', reason: 'Existing workspace-scoped route style to preserve.' },
      { file: 'migrations/001_create_workspace_projects.sql', reason: 'Existing persistence baseline for adding migration 002.' },
      { file: 'tests/project.service.test.ts', reason: 'Existing test style for continuation tests.' },
    ],
    selectedNode: null,
    validationPlan: { commands: [] },
    idiomContext: {
      product: 'klauro_greenfield_continuity_guidance',
      plan_intent: guidance.plan_intent,
      capability_memory: guidance.capability_memory,
      existing_overlap: guidance.existing_overlap,
      recommended_architecture: guidance.recommended_architecture,
      risks: guidance.risks,
    },
  }, commands);
}

async function scoreLiveGreenfieldContinuityTrial(
  livePair: LiveAgentPairResult,
  guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance>
) {
  const withFiles = await filesFromWorkspace(livePair.with_klauro.workspace);
  const withoutFiles = await filesFromWorkspace(livePair.without_klauro.workspace);
  const withPreview = withFiles.length ? await previewGreenfieldCodebase({
    title: 'Continuity live with Klauro',
    planText: 'Add project activity audit events and workspace-scoped notification settings.',
    proposedFiles: withFiles,
    previewBaseUrl: 'https://app.klauro.test',
  }) as any : null;
  const withoutPreview = withoutFiles.length ? await previewGreenfieldCodebase({
    title: 'Continuity live without Klauro',
    planText: 'Add project activity audit events and workspace-scoped notification settings.',
    proposedFiles: withoutFiles,
    previewBaseUrl: 'https://app.klauro.test',
  }) as any : null;
  const withPayload = withPreview?.preview?.id ? await getPreviewAnalysis(withPreview.preview.id) : null;
  const withoutPayload = withoutPreview?.preview?.id ? await getPreviewAnalysis(withoutPreview.preview.id) : null;
  const withScore = scoreGreenfieldContinuityBundle(withFiles, withPayload?.proposed_cas as any, guidance);
  const withoutScore = scoreGreenfieldContinuityBundle(withoutFiles, withoutPayload?.proposed_cas as any, null);
  const qualityDelta = withScore.score - withoutScore.score;
  const evaluatorQualityDelta = livePair.evaluation.quality_score_delta;
  const evaluatorArchitectureDelta = livePair.evaluation.architecture_score_delta;
  const evaluatorAgrees = evaluatorQualityDelta >= 0 &&
    (typeof evaluatorArchitectureDelta !== 'number' || evaluatorArchitectureDelta >= 0);

  return {
    status: liveProofAccepted(livePair, withScore.score, withoutScore.score, evaluatorAgrees) ? 'pass' : 'fail',
    status_reason: liveStatusReason(livePair),
    baseline_completed: livePair.without_klauro.command_passed === true,
    with_score: withScore.score,
    without_score: withoutScore.score,
    quality_delta: qualityDelta,
    evaluator_quality_delta: evaluatorQualityDelta,
    evaluator_architecture_delta: evaluatorArchitectureDelta,
    with_findings: withScore.findings,
    without_findings: withoutScore.findings,
    with_preview_id: withPreview?.preview?.id,
    without_preview_id: withoutPreview?.preview?.id,
    with_file_count: withFiles.length,
    without_file_count: withoutFiles.length,
  };
}

async function runLiveMassiveGreenfieldContinuityScenario(
  sliceOneFiles: ProposedFileInput[],
  continuationPlan: string,
  guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance>,
  commands: LiveAgentCommandConfig
): Promise<LiveAgentPairResult> {
  const starter = await createStarterRepoFromFiles('massive-work-platform', sliceOneFiles, [
    '# Massive Work Platform',
    '',
    'Slice one already implemented organizations, members, projects, tasks, organization-scoped role checks, project/task routes, repositories, a migration, and a focused service test.',
    '',
    'This repository is intentionally small, but it represents a growing product. New slices must extend the existing domain model and service boundaries instead of creating parallel concepts.',
    '',
  ].join('\n'));

  return runLiveAgentPair({
    repo: 'greenfield-continuity-massive-work-platform',
    repoPath: starter,
    taskId: 'greenfield-continuity-massive-work-platform',
    taskLabel: 'Grow a multi-tenant work platform without duplicating existing concepts',
    taskCategory: 'greenfield-continuity-massive',
    task: {
      task_type: 'modify',
      target: 'existing multi-tenant work platform',
      instructions: [
        continuationPlan,
        'This is a continuation of an existing codebase, not a clean-slate build.',
        'Preserve the existing organization/project/task model chain and route shape.',
        "New collaboration models must import and type-reference existing model IDs such as Organization['id'], Project['id'], and Task['id'] instead of recreating primitive parallel IDs in isolation.",
        'Reuse TaskService and ProjectService for behavior checks; do not create a separate collaboration project/task domain.',
        'Add persistence evidence and focused tests for the new behavior.',
        'Write task_success and quality_score into the result JSON when finished.',
      ].join(' '),
      success_criteria: [
        "Comments or audit events attach to existing tasks through organization/project/task scope and type-reference existing Task/Project/Organization IDs.",
        "Saved views or notifications are modeled through the existing organization boundary and type-reference Organization['id'].",
        'Weekly digest behavior reuses the existing services instead of creating duplicate project/task models.',
        'A second migration and focused continuation tests are present.',
      ],
      related_paths: [
        'src/models/organization.ts',
        'src/models/member.ts',
        'src/models/project.ts',
        'src/models/task.ts',
        'src/auth/organization-role.guard.ts',
        'src/services/project.service.ts',
        'src/services/task.service.ts',
        'src/routes/project.routes.ts',
        'src/routes/task.routes.ts',
        'migrations/001_create_work_platform.sql',
        'tests/task.service.test.ts',
      ],
    } as any,
    expectedOutcome: 'A continuation slice that adds collaboration and digest behavior by extending the existing organization/project/task architecture.',
    fileReadPlan: [
      { file: 'src/models/organization.ts', reason: 'Existing tenant domain model that new settings and saved views should reference.' },
      { file: 'src/models/project.ts', reason: 'Existing project model that should not be recreated under collaboration or reporting folders.' },
      { file: 'src/models/task.ts', reason: 'Existing task model that comments and attachments should attach to.' },
      { file: 'src/models/member.ts', reason: 'Existing member model for author/uploader references; reuse its ID shape rather than creating a second user/member concept.' },
      { file: 'src/services/project.service.ts', reason: 'Existing project service boundary to reuse for organization-scoped access.' },
      { file: 'src/services/task.service.ts', reason: 'Existing task service boundary to reuse for task-scoped collaboration.' },
      { file: 'src/routes/task.routes.ts', reason: 'Existing route shape for organization/project/task scoped endpoints.' },
      { file: 'migrations/001_create_work_platform.sql', reason: 'Persistence baseline for adding migration 002 only.' },
      { file: 'tests/task.service.test.ts', reason: 'Existing focused test style for continuation tests.' },
    ],
    selectedNode: null,
    validationPlan: { commands: [] },
    idiomContext: {
      product: 'klauro_massive_greenfield_continuity_guidance',
      plan_intent: guidance.plan_intent,
      capability_memory: guidance.capability_memory,
      existing_overlap: guidance.existing_overlap,
      recommended_architecture: guidance.recommended_architecture,
      risks: guidance.risks,
      do_not_rebuild: [
        'Organization',
        'Member',
        'Project',
        'Task',
        'organization role guard',
        'project/task route boundaries',
        'first migration',
      ],
      model_reuse: [
        "Import Organization, Project, Task, and Member types from src/models when new models store those IDs.",
        "Prefer Organization['id'], Project['id'], Task['id'], and Member['id'] for continuation models.",
        'Do not create collaboration/reporting Organization, Project, Task, Member, or DigestProject stand-ins.',
      ],
      boundary_rules: [
        'Extend src/services/task.service.ts for task comments, attachments, and audit behavior.',
        'Extend or call src/services/project.service.ts for organization/project access checks.',
        'Keep routes under the existing /organizations/:organizationId/projects/:projectId/tasks/:taskId shape.',
        'Add migration 002 only; do not copy or rewrite the first migration.',
      ],
    },
  }, commands);
}

async function scoreLiveMassiveGreenfieldContinuityTrial(
  livePair: LiveAgentPairResult,
  continuationPlan: string,
  guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance>
) {
  const withFiles = await filesFromWorkspace(livePair.with_klauro.workspace);
  const withoutFiles = await filesFromWorkspace(livePair.without_klauro.workspace);
  const withPreview = withFiles.length ? await previewGreenfieldCodebase({
    title: 'Massive continuity live with Klauro',
    planText: continuationPlan,
    proposedFiles: withFiles,
    previewBaseUrl: 'https://app.klauro.test',
  }) as any : null;
  const withoutPreview = withoutFiles.length ? await previewGreenfieldCodebase({
    title: 'Massive continuity live without Klauro',
    planText: continuationPlan,
    proposedFiles: withoutFiles,
    previewBaseUrl: 'https://app.klauro.test',
  }) as any : null;
  const withPayload = withPreview?.preview?.id ? await getPreviewAnalysis(withPreview.preview.id) : null;
  const withoutPayload = withoutPreview?.preview?.id ? await getPreviewAnalysis(withoutPreview.preview.id) : null;
  const withScore = scoreMassiveGreenfieldContinuityBundle(withFiles, withPayload?.proposed_cas as any, guidance);
  const withoutScore = scoreMassiveGreenfieldContinuityBundle(withoutFiles, withoutPayload?.proposed_cas as any, null);
  const qualityDelta = withScore.score - withoutScore.score;
  const evaluatorQualityDelta = livePair.evaluation.quality_score_delta;
  const evaluatorArchitectureDelta = livePair.evaluation.architecture_score_delta;
  const evaluatorAgrees = evaluatorQualityDelta >= 0 &&
    (typeof evaluatorArchitectureDelta !== 'number' || evaluatorArchitectureDelta >= 0);

  return {
    status: liveProofAccepted(livePair, withScore.score, withoutScore.score, evaluatorAgrees) ? 'pass' : 'fail',
    status_reason: liveStatusReason(livePair),
    baseline_completed: livePair.without_klauro.command_passed === true,
    with_score: withScore.score,
    without_score: withoutScore.score,
    quality_delta: qualityDelta,
    evaluator_quality_delta: evaluatorQualityDelta,
    evaluator_architecture_delta: evaluatorArchitectureDelta,
    with_findings: withScore.findings,
    without_findings: withoutScore.findings,
    with_preview_id: withPreview?.preview?.id,
    without_preview_id: withoutPreview?.preview?.id,
    with_file_count: withFiles.length,
    without_file_count: withoutFiles.length,
  };
}

async function createStarterRepoFromFiles(name: string, files: ProposedFileInput[], readme: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.env.HOME || '/tmp', `.klauro-${name}-live-starter-`));
  await fs.writeFile(path.join(root, 'README.md'), readme, 'utf8');
  for (const file of files) {
    const absolute = path.join(root, file.path);
    await fs.ensureDir(path.dirname(absolute));
    await fs.writeFile(absolute, file.content || '', 'utf8');
  }
  return root;
}

function scoreGreenfieldContinuityBundle(
  files: ProposedFileInput[],
  cas: any,
  guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance> | null
) {
  const paths = files.map(file => file.path);
  const content = files.map(file => `${file.path}\n${file.content || ''}`).join('\n');
  const findings = [];
  let score = 35;
  const duplicateModelPaths = paths.filter(file => /src\/activity\/(User|Workspace|Project)\.ts$/i.test(file));
  const duplicatedRouteBoundary = paths.some(file => /src\/activity\/project\.routes\.ts$/i.test(file));
  const projectModelContent = files.find(file => file.path === 'src/models/project.ts')?.content || '';
  const workspaceModelContent = files.find(file => file.path === 'src/models/workspace.ts')?.content || '';
  const importsExistingProjectModel = /from ['"]\.\/project['"]|from ['"]\.\.\/models\/project['"]/.test(content);
  const importsExistingWorkspaceModel = /from ['"]\.\/workspace['"]|from ['"]\.\.\/models\/workspace['"]/.test(content);
  const usesExistingProjectModel = importsExistingProjectModel ||
    /ProjectActivity|activity|lastActivity|activityCount/i.test(projectModelContent);
  const usesExistingWorkspaceModel = importsExistingWorkspaceModel ||
    /Notification|notification|settings|preferences/i.test(workspaceModelContent) ||
    /workspaceId|workspace_id|workspace_notification_settings/i.test(content);
  const extendsExistingProjectService = /from ['"]\.\/project\.service['"]|ProjectService/.test(content);
  const hasSecondMigration = paths.some(file => /migrations\/002_/i.test(file));
  const hasTest = paths.some(isTestPath);
  const hasActivityRoute = paths.some(file => /project-activity\.routes/i.test(file)) ||
    files.some(file => /src\/routes\/project\.routes\.ts$/i.test(file.path) && /activity|audit/i.test(file.content || ''));
  const hasActivityService = paths.some(file => /project-activity\.service/i.test(file)) ||
    files.some(file => /src\/services\/project\.service\.ts$/i.test(file.path) && /activity|audit/i.test(file.content || ''));
  const hasCasGraph = (cas?.nodes?.length || 0) > 0 && (cas?.edges?.length || 0) > 0;

  if (duplicateModelPaths.length === 0) score += 18; else findings.push(`Duplicates existing models: ${duplicateModelPaths.join(', ')}`);
  if (!duplicatedRouteBoundary) score += 8; else findings.push('Creates a parallel project route boundary instead of extending the existing workspace/project route style.');
  if (usesExistingProjectModel) score += 10; else findings.push('Does not reference or extend the existing Project model.');
  if (usesExistingWorkspaceModel) score += 8; else findings.push('Does not reference or extend the existing Workspace model/scope.');
  if (extendsExistingProjectService) score += 12; else findings.push('Does not extend or verify through the existing ProjectService boundary.');
  if (hasSecondMigration) score += 7; else findings.push('No second migration for the new slice.');
  if (hasTest) score += 7; else findings.push('No slice-two test.');
  if (hasActivityRoute && hasActivityService) score += 7; else findings.push('Missing activity route/service boundary.');
  if (hasCasGraph) score += 5; else findings.push('CAS did not produce a meaningful graph.');
  if ((guidance?.capability_memory.reuse_decisions_required.length || 0) > 0) score += 5;
  if ((guidance?.capability_memory.do_not_rebuild.length || 0) > 0) score += 3;

  const cappedScore = findings.length
    ? Math.min(score, Math.max(45, 92 - (findings.length * 8)))
    : score;
  return { score: Math.min(100, cappedScore), findings };
}

function scoreMassiveGreenfieldContinuityBundle(
  files: ProposedFileInput[],
  cas: any,
  guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance> | null
) {
  const paths = files.map(file => file.path);
  const content = files.map(file => `${file.path}\n${file.content || ''}`).join('\n');
  const findings = [];
  let score = 30;

  const duplicatedModelPaths = paths.filter(file =>
    /src\/(collaboration|reports)\/(Organization|Project|Task|Member|DigestProject)\.ts$/i.test(file)
  );
  const duplicatedRouteBoundary = paths.some(file => /src\/collaboration\/project\.routes\.ts$/i.test(file));
  const importsExistingTask = /from ['"]\.\/task['"]|from ['"]\.\.\/models\/task['"]|Task\['id'\]/.test(content);
  const importsExistingProject = /from ['"]\.\/project['"]|from ['"]\.\.\/models\/project['"]|ProjectService/.test(content);
  const importsExistingOrganization = /from ['"]\.\/organization['"]|from ['"]\.\.\/models\/organization['"]|Organization\['id'\]/.test(content);
  const usesExistingTaskService = /from ['"]\.\/task\.service['"]|TaskService/.test(content);
  const usesExistingProjectService = /from ['"]\.\/project\.service['"]|ProjectService/.test(content);
  const hasIncrementalMigration = paths.some(file => /migrations\/002_/i.test(file)) && !paths.some(file => /migrations\/001_.*copy|migrations\/002_create_work_platform/i.test(file));
  const hasFocusedTests = paths.filter(isTestPath).length >= 2;
  const hasWorker = paths.some(file => /src\/workers\/weekly-digest\.worker\.ts$/i.test(file));
  const hasSavedView = paths.some(file => /src\/models\/saved-view\.ts$/i.test(file)) && /SavedViewService/.test(content);
  const hasCommentsAndAttachments = /interface Comment/.test(content) && /interface Attachment/.test(content);
  const hasScopedRoutes = /organizations\/:organizationId\/projects\/:projectId\/tasks\/:taskId\/comments/.test(content);
  const hasCasGraph = (cas?.nodes?.length || 0) > 0 && (cas?.edges?.length || 0) > 0;
  const hasCapabilityMemory = (guidance?.capability_memory.reuse_decisions_required.length || 0) > 0;
  const hasDoNotRebuild = (guidance?.capability_memory.do_not_rebuild.length || 0) > 0;

  if (duplicatedModelPaths.length === 0) score += 16; else findings.push(`Duplicates established domain models: ${duplicatedModelPaths.join(', ')}`);
  if (!duplicatedRouteBoundary) score += 7; else findings.push('Creates a parallel collaboration route boundary instead of following existing route style.');
  if (importsExistingTask && importsExistingProject && importsExistingOrganization) score += 14; else findings.push('Does not reference the existing organization/project/task model chain.');
  if (usesExistingTaskService && usesExistingProjectService) score += 12; else findings.push('Does not reuse the existing TaskService and ProjectService boundaries.');
  if (hasIncrementalMigration) score += 8; else findings.push('No incremental migration for collaboration/saved-view data.');
  if (hasFocusedTests) score += 8; else findings.push('Missing focused continuation tests.');
  if (hasWorker) score += 6; else findings.push('No weekly digest worker boundary.');
  if (hasSavedView) score += 6; else findings.push('Saved views are not modeled through an existing organization boundary.');
  if (hasCommentsAndAttachments) score += 6; else findings.push('Comments and attachments are incomplete.');
  if (hasScopedRoutes) score += 5; else findings.push('Routes do not preserve organization/project/task scope.');
  if (hasCasGraph) score += 4; else findings.push('CAS did not produce a meaningful graph.');
  if (hasCapabilityMemory) score += 5; else findings.push('Klauro guidance did not produce reuse decisions.');
  if (hasDoNotRebuild) score += 3; else findings.push('Klauro guidance did not warn against rebuilding existing capabilities.');

  const cappedScore = findings.length
    ? Math.min(score, Math.max(40, 94 - (findings.length * 7)))
    : score;
  return { score: Math.min(100, cappedScore), findings };
}

async function filesFromWorkspace(workspace: string): Promise<ProposedFileInput[]> {
  if (!workspace || !(await fs.pathExists(workspace))) return [];
  const files = await listWorkspaceFiles(workspace);
  const proposed: ProposedFileInput[] = [];
  for (const file of files) {
    const absolute = path.join(workspace, file);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile() || stat.size > 500_000) continue;
    proposed.push({ path: file, content: await fs.readFile(absolute, 'utf8'), status: 'added' });
  }
  return proposed;
}

async function listWorkspaceFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'target', 'coverage', '.next', '.turbo', '.cache', '.venv', 'venv']);
  const visit = async (directory: string) => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await visit(absolute);
      } else if (entry.isFile() && isCandidateGreenfieldFile(relative)) {
        results.push(relative);
      }
    }
  };
  await visit(root);
  return results.sort();
}

function isCandidateGreenfieldFile(filePath: string): boolean {
  if (/(^|\/)\.klauro-live-(metrics|result)\.json$/.test(filePath)) return false;
  if (/^README\.md$/i.test(filePath)) return false;
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|php|dart|json|sql|toml|yaml|yml|md)$/.test(filePath);
}

export function scoreGreenfieldBundle(
  scenario: Scenario,
  files: ProposedFileInput[],
  cas: any,
  guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance> | null
) {
  const paths = files.map(file => file.path);
  const findings = [];
  let score = 30;
  const hasSource = paths.some(isSourcePath);
  const hasTest = paths.some(isTestPath);
  const hasApi = paths.some(file => /controller|route|handler|api/i.test(file));
  const hasService = paths.some(file => /service|usecase|interactor/i.test(file));
  const hasData = paths.some(file => /model|entity|schema|repository|prisma/i.test(file));
  const hasMigration = paths.some(file => /migration|migrations/i.test(file));
  const hasUi = paths.some(file => /component|page|view|route/i.test(file));
  const hasWorker = paths.some(file => /worker|job|queue|event/i.test(file));
  const hasExternal = files.some(file => /stripe|github|slack|webhook|external|client|sdk/i.test(`${file.path}\n${file.content || ''}`));
  const hasInstallArtifact = paths.some(file => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i.test(file));
  const generatedFileCount = paths.filter(file => !/(^|\/)(package\.json|tsconfig\.json|pyproject\.toml|go\.mod|cargo\.toml|composer\.json|pubspec\.yaml)$/i.test(file)).length;
  const nodeCount = cas?.nodes?.length || 0;
  const entryCount = cas?.entry_points?.length || 0;

  if (hasSource) score += 8; else findings.push('No source files supplied.');
  if (nodeCount > 0) score += 8; else findings.push('CAS preview did not produce source nodes.');
  if (entryCount > 0 || !scenario.required.api) score += 8; else findings.push('No API entry point detected.');
  if (scenario.required.api && hasApi) score += 8; else if (scenario.required.api) findings.push('Missing API boundary file.');
  if ((scenario.required.api || scenario.required.data) && hasService) score += 8; else if (scenario.required.api || scenario.required.data) findings.push('Missing service/business logic layer.');
  if (scenario.required.data && hasData) score += 8; else if (scenario.required.data) findings.push('Missing model/repository/data layer.');
  if (scenario.required.data && hasMigration) score += 8; else if (scenario.required.data) findings.push('Missing migration evidence.');
  if (scenario.required.ui && hasUi) score += 8; else if (scenario.required.ui) findings.push('Missing UI page/component boundary.');
  if (scenario.required.worker && hasWorker) score += 8; else if (scenario.required.worker) findings.push('Missing worker/event boundary.');
  if (scenario.required.external && hasExternal) score += 6; else if (scenario.required.external) findings.push('Missing external integration boundary.');
  if (hasSource && hasTest) score += 10; else findings.push('No tests supplied for proposed source files.');
  if (guidance?.existing_overlap.status === 'overlap-found') score += 8;
  if ((guidance?.recommended_architecture.patterns.length || 0) > 0) score += 6;
  if ((guidance?.risks || []).some(risk => risk.risk === 'Potential duplicate capability')) score += 4;
  if (hasInstallArtifact) {
    score -= 8;
    findings.push('Generated dependency-install artifacts despite live benchmark instruction not to install dependencies.');
  }
  if (generatedFileCount > 18) {
    score -= Math.min(10, Math.ceil((generatedFileCount - 18) / 4) * 2);
    findings.push(`Generated a broad ${generatedFileCount}-file slice instead of a tightly bounded first slice.`);
  }

  return { score: Math.max(0, Math.min(100, score)), findings };
}

function buildScenarios(): Scenario[] {
  return [
    {
      id: 'portfolio-reporting-api',
      title: 'Portfolio reporting API',
      plan: 'Build a portfolio reporting API with authenticated users, portfolios, holdings, report generation, and Stripe billing webhooks. Avoid rebuilding existing portfolio or billing behavior if it already exists in analyzed repos.',
      required: { api: true, data: true, auth: true, external: true },
      baselineFiles: [
        {
          path: 'src/app.ts',
          content: [
            "import express from 'express';",
            'const app = express();',
            "app.post('/reports', async (_req, res) => {",
            "  const portfolio = { id: 'p1', holdings: [] };",
            "  res.json({ portfolio, report: 'ok' });",
            '});',
            'export default app;',
            '',
          ].join('\n'),
        },
      ],
      guidedFiles: [
        { path: 'package.json', content: JSON.stringify({ dependencies: { express: '^4.18.0', stripe: '^16.0.0' }, devDependencies: { jest: '^29.0.0' } }, null, 2) },
        { path: 'src/routes/report.routes.ts', content: "import express from 'express';\nimport { ReportService } from '../services/report.service';\nexport const reportRouter = express.Router();\nreportRouter.post('/reports', async (req, res) => res.json(await new ReportService().generate(req.body)));\n" },
        { path: 'src/services/report.service.ts', content: "import { PortfolioRepository } from '../repositories/portfolio.repository';\nexport class ReportService {\n  async generate(input: unknown) {\n    const portfolio = await new PortfolioRepository().findForReport(input);\n    return { portfolio, status: 'ready' };\n  }\n}\n" },
        { path: 'src/repositories/portfolio.repository.ts', content: "export class PortfolioRepository {\n  async findForReport(_input: unknown) { return { id: 'portfolio', holdings: [] }; }\n}\n" },
        { path: 'src/models/portfolio.ts', content: 'export interface Portfolio { id: string; holdings: Array<{ symbol: string; quantity: number }>; }\n' },
        { path: 'src/integrations/stripe.client.ts', content: "import Stripe from 'stripe';\nexport const stripe = new Stripe(process.env.STRIPE_KEY || 'test');\n" },
        { path: 'migrations/001_create_portfolio_reports.sql', content: 'CREATE TABLE portfolio_reports (id text primary key, portfolio_id text not null, created_at timestamp not null);\n' },
        { path: 'tests/report.service.test.ts', content: "import { ReportService } from '../src/services/report.service';\ntest('generates a report from portfolio holdings', async () => {\n  await expect(new ReportService().generate({ portfolioId: 'p1' })).resolves.toMatchObject({ status: 'ready' });\n});\n" },
      ],
    },
    {
      id: 'operations-dashboard',
      title: 'Operations dashboard',
      plan: 'Build a React operations dashboard that shows project health, analysis readiness, and proposal preview status. Reuse existing analysis and preview concepts instead of inventing a second status model.',
      required: { ui: true, api: false, data: false },
      baselineFiles: [
        { path: 'src/App.tsx', content: 'export default function App() { return <div>Dashboard with everything hardcoded</div>; }\n' },
      ],
      guidedFiles: [
        { path: 'package.json', content: JSON.stringify({ dependencies: { react: '^18.0.0' }, devDependencies: { vitest: '^1.0.0' } }, null, 2) },
        { path: 'src/routes/OperationsDashboard.tsx', content: "import { AnalysisReadinessPanel } from '../components/AnalysisReadinessPanel';\nexport function OperationsDashboard() { return <AnalysisReadinessPanel status=\"ready\" />; }\n" },
        { path: 'src/components/AnalysisReadinessPanel.tsx', content: "export function AnalysisReadinessPanel(props: { status: 'ready' | 'warn' | 'fail' }) { return <section>{props.status}</section>; }\n" },
        { path: 'src/hooks/useProposalPreviewStatus.ts', content: "export function useProposalPreviewStatus() { return { status: 'ready' as const, previewUrl: '/previews/latest' }; }\n" },
        { path: 'src/components/AnalysisReadinessPanel.test.tsx', content: "import { AnalysisReadinessPanel } from './AnalysisReadinessPanel';\ntest('renders readiness status', () => { expect(AnalysisReadinessPanel({ status: 'ready' })).toBeTruthy(); });\n" },
      ],
    },
    {
      id: 'analysis-worker',
      title: 'Analysis worker',
      plan: 'Build a background worker that receives codebase analysis jobs, updates incremental state, emits completion events, and records retry-safe status. Keep the async boundary separate from analyzer logic.',
      required: { worker: true, data: true },
      baselineFiles: [
        { path: 'src/index.ts', content: "export async function run(job: any) { console.log('analyze', job); return true; }\n" },
      ],
      guidedFiles: [
        { path: 'src/workers/analysis.worker.ts', content: "import { AnalysisJobService } from '../services/analysis-job.service';\nexport async function handleAnalysisJob(job: { id: string; path: string }) { return new AnalysisJobService().process(job); }\n" },
        { path: 'src/services/analysis-job.service.ts', content: "import { AnalysisJobRepository } from '../repositories/analysis-job.repository';\nexport class AnalysisJobService { async process(job: { id: string; path: string }) { await new AnalysisJobRepository().markComplete(job.id); return { ok: true }; } }\n" },
        { path: 'src/repositories/analysis-job.repository.ts', content: "export class AnalysisJobRepository { async markComplete(id: string) { return { id, status: 'complete' }; } }\n" },
        { path: 'src/events/analysis-completed.event.ts', content: 'export interface AnalysisCompletedEvent { jobId: string; analysisId: string; }\n' },
        { path: 'migrations/001_create_analysis_jobs.sql', content: 'CREATE TABLE analysis_jobs (id text primary key, status text not null, updated_at timestamp not null);\n' },
        { path: 'tests/analysis.worker.test.ts', content: "import { handleAnalysisJob } from '../src/workers/analysis.worker';\ntest('processes analysis job', async () => { await expect(handleAnalysisJob({ id: 'j1', path: '/tmp/repo' })).resolves.toMatchObject({ ok: true }); });\n" },
      ],
    },
  ];
}

function formatGreenfieldBenchmarkMarkdown(report: Awaited<ReturnType<typeof runAgentGreenfieldBenchmark>>): string {
  const lines = [
    '# Klauro Greenfield Agent Benchmark',
    '',
    `Generated: ${report.generated_at}`,
    `Status: ${report.status}`,
    `Score: ${report.score}/100`,
    `Proof strength: ${report.summary.proof_strength}`,
    `References: ${report.reference_count}`,
    `Scenarios: ${report.summary.scenario_count}`,
    `Average quality delta: +${report.summary.average_quality_delta}`,
    `Claim limit: ${report.summary.claim_limit}`,
    `Token savings: ${report.summary.token_savings_status} - ${report.summary.token_savings_claim}`,
    '',
    '| Scenario | Status | Baseline | With Klauro | Delta | Preview |',
    '| --- | --- | ---: | ---: | ---: | --- |',
  ];
  for (const result of report.results) {
    lines.push(`| ${result.title} | ${result.status} | ${result.baseline.score} | ${result.with_klauro.score} | +${result.score_delta} | ${result.with_klauro.preview_url} |`);
  }
  if (report.continuity_trials.length) {
    lines.push('', '## Continuity Trials', '');
    lines.push('| Trial | Status | Baseline | With Klauro | Delta | Slice 1 Preview | Slice 2 Preview |');
    lines.push('| --- | --- | ---: | ---: | ---: | --- | --- |');
    for (const trial of report.continuity_trials) {
      lines.push(`| ${trial.title} | ${trial.status} | ${trial.baseline.score} | ${trial.with_klauro.score} | +${trial.score_delta} | ${trial.slice_one.preview_url} | ${trial.with_klauro.preview_url} |`);
    }
  }
  lines.push('', '## Details', '');
  for (const result of report.results) {
    lines.push(`### ${result.title}`, '');
    lines.push(`Baseline findings: ${result.baseline.findings.join('; ') || 'none'}`);
    lines.push(`With Klauro findings: ${result.with_klauro.findings.join('; ') || 'none'}`);
    lines.push(`Patterns: ${result.with_klauro.recommended_patterns.join(', ') || 'none'}`);
    lines.push(`Overlap: ${result.with_klauro.overlap_status} (${result.with_klauro.overlap_matches} matches)`);
    lines.push('');
  }
  for (const trial of report.continuity_trials) {
    lines.push(`### ${trial.title}`, '');
    lines.push(`Baseline findings: ${trial.baseline.findings.join('; ') || 'none'}`);
    lines.push(`With Klauro findings: ${trial.with_klauro.findings.join('; ') || 'none'}`);
    lines.push(`Reuse decisions required: ${trial.with_klauro.reuse_decisions_required.length}`);
    lines.push(`Do not rebuild warnings: ${trial.with_klauro.do_not_rebuild.length}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function loadReferences(paths: string[]): Promise<GreenfieldReferenceAnalysis[]> {
  const references: GreenfieldReferenceAnalysis[] = [];
  for (const referencePath of paths) {
    if (!fs.existsSync(referencePath)) continue;
    const absolute = path.resolve(referencePath);
    try {
      let cas;
      try {
        cas = await getAnalysis(absolute);
      } catch {
        cas = await analyzeForBench(absolute);
      }
      references.push({
        path: absolute,
        name: cas.system?.name || path.basename(absolute),
        cas,
      });
    } catch (error) {
      references.push({
        path: absolute,
        name: path.basename(absolute),
        cas: emptyReferenceCas(absolute, error),
      });
    }
  }
  return references.filter(reference => reference.cas.nodes.length > 0);
}

function emptyReferenceCas(root: string, error: unknown): any {
  return {
    cas_version: 'error',
    analysis_timestamp: new Date().toISOString(),
    analysis_id: `error-${path.basename(root)}`,
    system: { id: path.basename(root), name: path.basename(root), type: 'application', root_path: root, description: String(error instanceof Error ? error.message : error) },
    nodes: [],
    edges: [],
    analyzer_contributions: [],
    progressive_levels: { level_1: {}, level_2: {}, level_3: {}, level_4: {} },
  };
}

function defaultReferencePaths(): string[] {
  return defaultBenchmarkReferencePaths(__dirname);
}

function isSourcePath(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|php|dart)$/.test(filePath) && !isTestPath(filePath);
}

function isTestPath(filePath: string): boolean {
  return /(^|\/)(__tests__|tests?|specs?)\/|(\.|-)(test|spec)\./i.test(filePath);
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function conservativeLiveQualityDelta(liveScore: any, livePair: LiveAgentPairResult | undefined): number | null {
  const deltas = [
    typeof liveScore?.quality_delta === 'number' ? liveScore.quality_delta : undefined,
    typeof livePair?.evaluation?.quality_score_delta === 'number' ? livePair.evaluation.quality_score_delta : undefined,
    typeof livePair?.evaluation?.architecture_score_delta === 'number' ? livePair.evaluation.architecture_score_delta : undefined,
  ].filter((value): value is number => typeof value === 'number');
  return deltas.length ? Math.min(...deltas) : null;
}

function liveProofAccepted(
  livePair: LiveAgentPairResult,
  withScore: number,
  withoutScore: number,
  evaluatorAgrees: boolean
): boolean {
  if (livePair.evaluation.status !== 'pass') return false;
  if (livePair.with_klauro.command_passed !== true) return false;
  if (withScore < withoutScore) return false;
  if (!evaluatorAgrees) return false;
  return livePair.without_klauro.attempted === true;
}

function liveStatusReason(livePair: LiveAgentPairResult): string {
  if (livePair.without_klauro.command_passed === true) return 'both-arms-completed';
  if (livePair.without_klauro.timed_out) return 'with-klauro-completed-while-baseline-timed-out';
  return 'with-klauro-completed-while-baseline-failed';
}

function liveTokenSavingsStatus(results: any[], continuityTrials: any[]): string {
  const liveItems = [
    ...results.filter(result => result.live_pair),
    ...continuityTrials.filter(trial => trial.live_pair),
  ];
  if (!liveItems.length) return 'not-measured-without-live-agent';
  const reductions = liveItems
    .map(item => item.live_pair?.evaluation?.token_reduction_percentage)
    .filter((value): value is number => typeof value === 'number');
  return reductions.length ? 'live-measured' : 'live-partial-no-baseline-token-total';
}

function liveTokenSavingsClaim(results: any[], continuityTrials: any[]): string {
  const status = liveTokenSavingsStatus(results, continuityTrials);
  if (status === 'not-measured-without-live-agent') {
    return 'No greenfield token-savings claim is made by this deterministic run; run with live agents to measure total prompt/context/tool tokens.';
  }
  if (status === 'live-partial-no-baseline-token-total') {
    return 'Live run measured success/time/quality, but token reduction is not claimed when a baseline arm fails or omits provider token totals.';
  }
  return 'Use live_average_token_reduction and live_continuity_average_token_reduction for token claims.';
}

function liveTaskAllowed(commands: LiveAgentCommandConfig, taskId: string, category: string): boolean {
  const taskIds = commands.liveTaskTypes || [];
  if (taskIds.length && !taskIds.includes(taskId)) return false;
  return liveCategoryAllowed(commands, category);
}

function liveCategoryAllowed(commands: LiveAgentCommandConfig, category: string): boolean {
  const categories = commands.liveTaskCategories || [];
  return categories.length === 0 || categories.includes(category);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    references: defaultReferencePaths(),
    outputPath: path.join(process.cwd(), '.klauro-agent-greenfield-benchmark', 'latest-report.json'),
    markdownPath: path.join(process.cwd(), '.klauro-agent-greenfield-benchmark', 'latest-report.md'),
    liveRequested: false,
    commands: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--reference-path') args.references.push(path.resolve(argv[++i]));
    else if (arg === '--no-default-references') args.references = [];
    else if (arg === '--output') args.outputPath = argv[++i];
    else if (arg === '--markdown') args.markdownPath = argv[++i];
    else if (arg === '--live') args.liveRequested = true;
    else if (arg === '--agent-with-cmd') args.commands.withKlauro = argv[++i];
    else if (arg === '--agent-without-cmd') args.commands.withoutKlauro = argv[++i];
    else if (arg === '--orchestrator-cmd' || arg === '--evaluator-cmd') args.commands.orchestrator = argv[++i];
    else if (arg === '--test-command') args.commands.testCommand = argv[++i];
    else if (arg === '--work-root') args.commands.workRoot = path.resolve(argv[++i]);
    else if (arg === '--max-live-tasks') args.commands.maxLiveTasks = Number(argv[++i]);
    else if (arg === '--live-task-category') {
      const category = argv[++i];
      if (!category) throw new Error('--live-task-category requires a category value');
      args.commands.liveTaskCategories = [...(args.commands.liveTaskCategories || []), category];
    }
    else if (arg === '--live-task-id') {
      const taskId = argv[++i];
      if (!taskId) throw new Error('--live-task-id requires a scenario id');
      args.commands.liveTaskTypes = [...(args.commands.liveTaskTypes || []), taskId];
    }
    else if (arg === '--timeout-ms') args.commands.timeoutMs = Number(argv[++i]);
    else if (arg === '--test-timeout-ms') args.commands.testTimeoutMs = Number(argv[++i]);
    else if (arg === '--orchestrator-timeout-ms') args.commands.orchestratorTimeoutMs = Number(argv[++i]);
    else if (arg === '--keep-workspaces') args.commands.keepWorkspaces = true;
    else if (arg === '--discard-workspaces') args.commands.keepWorkspaces = false;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return args;
}

if (isDirectCliInvocation('agent-greenfield-benchmark')) {
  runAgentGreenfieldBenchmark(parseArgs(process.argv.slice(2)))
    .then(report => {
      process.stdout.write(`Greenfield benchmark: ${report.status.toUpperCase()} (${report.score}/100)\n`);
      process.stdout.write(`Scenarios: ${report.summary.scenario_count} | Improved: ${report.summary.scenarios_improved} | Average quality delta: +${report.summary.average_quality_delta}\n`);
      const parsed = parseArgs(process.argv.slice(2));
      process.stdout.write(`Report: ${parsed.outputPath}\n`);
      process.stdout.write(`Markdown: ${parsed.markdownPath}\n`);
      process.exit(report.status === 'pass' ? 0 : 1);
    })
    .catch(error => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exit(1);
    });
}
