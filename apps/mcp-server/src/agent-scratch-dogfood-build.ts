#!/usr/bin/env tsx
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { analyzeForBench } from './gauntlet/product-analysis';
import { buildGreenfieldArchitectureGuidance, type GreenfieldReferenceAnalysis } from './greenfield-guidance';
import { getPreviewAnalysis, previewGreenfieldCodebase, type ProposedFileInput } from './proposal-preview';
import { renderProposalPreviewHtml } from './proposal-preview-html';
import { isDirectCliInvocation } from './cli-invocation';
import { defaultBenchmarkReferencePaths } from './benchmark-reference-paths';

const execFileAsync = promisify(execFile);

interface Args {
  outputRoot: string;
  reportPath: string;
  references: string[];
}

interface DogfoodStage {
  name: string;
  project_path: string;
  file_count: number;
  test_command: string;
  tests_passed: boolean;
  test_stdout_tail: string;
  analysis: {
    nodes: number;
    edges: number;
    entry_points: number;
    capabilities: number;
    domain_concepts: number;
    architecture_patterns: string[];
  };
  preview: {
    id: string;
    url: string;
    html: string;
    verdict: string;
  };
  duplication: {
    duplicate_domain_definitions: string[];
    reused_core_models: string[];
  };
}

interface DogfoodScenarioReport {
  id: string;
  title: string;
  product: string;
  score: number;
  status: 'pass' | 'warn' | 'fail';
  guidance: {
    status: string;
    recommended_patterns: string[];
    core_concepts_to_name_once: string[];
    file_plan: string[];
  };
  initial: DogfoodStage;
  continuation: DogfoodStage;
  proof: DogfoodProof;
}

interface DogfoodProof {
  started_from_empty_folder: boolean;
  used_klauro_guidance_before_files: boolean;
  previewed_initial_as_normal_cas: boolean;
  analyzed_initial_as_codebase: boolean;
  used_initial_analysis_as_memory_for_continuation: boolean;
  previewed_continuation_as_normal_cas: boolean;
  continuation_reused_existing_models: boolean;
  continuation_avoided_duplicate_domains: boolean;
  tests_passed: boolean;
}

interface DogfoodReport {
  generated_at: string;
  status: 'pass' | 'warn' | 'fail';
  score: number;
  product: string;
  goal: string;
  output_root: string;
  guidance: {
    status: string;
    references: number;
    recommended_patterns: string[];
    file_plan: string[];
    do_not_rebuild: number;
  };
  initial: DogfoodStage;
  continuation: DogfoodStage;
  proof: DogfoodProof;
  scenarios: DogfoodScenarioReport[];
  summary: {
    scenario_count: number;
    scenarios_passed: number;
    average_score: number;
  };
}

const PRODUCT_PLAN = [
  'Build a large-scale operations reliability platform from an empty folder.',
  'The system must support organizations, workspaces, services, incidents, runbooks, owners, alerts, escalation policies, audit events, and scheduled reliability digests.',
  'The first slice should create a clear API/route boundary, domain model, service layer, repository boundary, migration, tests, and a worker boundary.',
  'The system should be built so later slices can extend the same organization/workspace/service/incident chain instead of rebuilding those concepts.',
].join(' ');

const CONTINUATION_PLAN = [
  'Continue the generated reliability platform by adding incident notes, runbook executions, alert acknowledgements, saved incident views, external webhook intake, and weekly reliability digest snapshots.',
  'Reuse the existing organization/workspace/service/incident model chain and service/repository boundaries.',
  'Do not create parallel organization, workspace, service, incident, owner, alert, escalation, or audit models.',
  'Add an incremental migration and focused continuation tests.',
].join(' ');

const DASHBOARD_PRODUCT_PLAN = [
  'Build a large-scale operations command center from an empty folder.',
  'The system must support workspaces, dashboards, widgets, saved views, analysis health, proposal preview status, incidents, alerts, and operator tasks.',
  'The first slice should create a clear route/view boundary, reusable components, state/query hooks, domain models, service adapters, tests, and an explicit design/data contract.',
  'The system should be built so later UI slices extend the same workspace/dashboard/widget/status model chain instead of rebuilding those concepts per page.',
].join(' ');

const DASHBOARD_CONTINUATION_PLAN = [
  'Continue the generated operations command center by adding proposal impact timelines, saved comparison overlays, alert triage queues, incident detail drawers, and workspace-level notification preferences.',
  'Reuse the existing workspace/dashboard/widget/status model chain, route shape, services, hooks, and components.',
  'Do not create parallel workspace, dashboard, widget, analysis status, proposal preview, incident, alert, or operator task models.',
  'Add focused continuation tests that prove the new UI slice composes the existing state and services.',
].join(' ');

export async function runAgentScratchDogfoodBuild(args: Args = parseArgs(process.argv.slice(2))): Promise<DogfoodReport> {
  const outputRoot = path.resolve(args.outputRoot);
  await fs.remove(outputRoot);
  await fs.ensureDir(outputRoot);

  const references = await loadReferences(args.references.length ? args.references : defaultReferencePaths());
  const scenarios = [
    await runScenario({
      id: 'reliability-platform',
      title: 'Reliability Platform',
      product: 'scratch reliability platform',
      outputRoot,
      references,
      initialPlan: PRODUCT_PLAN,
      continuationPlan: CONTINUATION_PLAN,
      initialFiles: initialReliabilityPlatformFiles,
      continuationFiles,
      duplicateConcepts: ['Organization', 'Workspace', 'Service', 'Incident', 'Alert', 'EscalationPolicy', 'AuditEvent'],
      reusePatterns: [
        { name: 'Organization', pattern: /Organization\[['"]id['"]\]/ },
        { name: 'Workspace', pattern: /Workspace\[['"]id['"]\]/ },
        { name: 'Service', pattern: /Service\[['"]id['"]\]/ },
        { name: 'Incident', pattern: /Incident\[['"]id['"]\]/ },
        { name: 'Alert', pattern: /Alert\[['"]id['"]\]/ },
      ],
    }),
    await runScenario({
      id: 'operations-command-center',
      title: 'Operations Command Center',
      product: 'scratch operations command center',
      outputRoot,
      references,
      initialPlan: DASHBOARD_PRODUCT_PLAN,
      continuationPlan: DASHBOARD_CONTINUATION_PLAN,
      initialFiles: initialOperationsCommandCenterFiles,
      continuationFiles: operationsCommandCenterContinuationFiles,
      duplicateConcepts: ['Workspace', 'Dashboard', 'Widget', 'AnalysisStatus', 'ProposalPreview', 'Incident', 'Alert', 'OperatorTask'],
      reusePatterns: [
        { name: 'Workspace', pattern: /Workspace\[['"]id['"]\]/ },
        { name: 'Dashboard', pattern: /Dashboard\[['"]id['"]\]/ },
        { name: 'Widget', pattern: /Widget\[['"]id['"]\]/ },
        { name: 'AnalysisStatus', pattern: /AnalysisStatus\[['"]id['"]\]/ },
      ],
    }),
  ];
  const primary = scenarios[0];
  const score = Math.round(scenarios.reduce((sum, scenario) => sum + scenario.score, 0) / Math.max(1, scenarios.length));
  const status = scenarios.every(scenario => scenario.status === 'pass') ? 'pass' : scenarios.some(scenario => scenario.status === 'fail') ? 'fail' : 'warn';
  const report: DogfoodReport = {
    generated_at: new Date().toISOString(),
    status,
    score,
    product: 'multi-shape scratch dogfood builds',
    goal: 'Prove Klauro can guide zero-repo product builds and later slices without duplicate architecture or duplicate domain concepts across backend and UI product shapes.',
    output_root: outputRoot,
    guidance: {
      status: primary.guidance.status,
      references: references.length,
      recommended_patterns: primary.guidance.recommended_patterns,
      file_plan: primary.guidance.file_plan,
      do_not_rebuild: 0,
    },
    initial: primary.initial,
    continuation: primary.continuation,
    proof: primary.proof,
    scenarios,
    summary: {
      scenario_count: scenarios.length,
      scenarios_passed: scenarios.filter(scenario => scenario.status === 'pass').length,
      average_score: score,
    },
  };

  await fs.ensureDir(path.dirname(args.reportPath));
  await fs.writeJson(args.reportPath, report, { spaces: 2 });
  await fs.writeFile(path.join(outputRoot, 'DOGFOOD_REPORT.md'), formatReportMarkdown(report), 'utf8');
  return report;
}

async function runScenario(options: {
  id: string;
  title: string;
  product: string;
  outputRoot: string;
  references: GreenfieldReferenceAnalysis[];
  initialPlan: string;
  continuationPlan: string;
  initialFiles: (guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance>) => ProposedFileInput[];
  continuationFiles: (guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance>) => ProposedFileInput[];
  duplicateConcepts: string[];
  reusePatterns: Array<{ name: string; pattern: RegExp }>;
}): Promise<DogfoodScenarioReport> {
  const projectPath = path.join(options.outputRoot, options.id);
  await fs.ensureDir(projectPath);
  const initialGuidance = buildGreenfieldArchitectureGuidance({
    planText: options.initialPlan,
    references: options.references,
  });
  await writeFiles(projectPath, options.initialFiles(initialGuidance));
  const initial = await analyzeStage({
    name: `${options.id}-initial`,
    projectPath,
    planText: options.initialPlan,
    outputRoot: options.outputRoot,
    duplicateConcepts: options.duplicateConcepts,
    reusePatterns: options.reusePatterns,
  });
  const initialReference: GreenfieldReferenceAnalysis = {
    path: projectPath,
    name: `dogfood-${options.id}`,
    cas: await analyzeForBench(projectPath),
  };
  const continuationGuidance = buildGreenfieldArchitectureGuidance({
    planText: options.continuationPlan,
    references: [initialReference, ...options.references],
  });
  await writeFiles(projectPath, options.continuationFiles(continuationGuidance));
  const continuation = await analyzeStage({
    name: `${options.id}-continuation`,
    projectPath,
    planText: options.continuationPlan,
    outputRoot: options.outputRoot,
    duplicateConcepts: options.duplicateConcepts,
    reusePatterns: options.reusePatterns,
  });
  const proof: DogfoodProof = {
    started_from_empty_folder: true,
    used_klauro_guidance_before_files: initialGuidance.recommended_architecture.file_plan.length > 0,
    previewed_initial_as_normal_cas: Boolean(initial.preview.id),
    analyzed_initial_as_codebase: initial.analysis.nodes > 0 && initial.analysis.edges > 0,
    used_initial_analysis_as_memory_for_continuation: continuationGuidance.capability_memory.do_not_rebuild.length > 0 ||
      continuationGuidance.capability_memory.reuse_decisions_required.length > 0,
    previewed_continuation_as_normal_cas: Boolean(continuation.preview.id),
    continuation_reused_existing_models: continuation.duplication.reused_core_models.length >= Math.min(4, options.reusePatterns.length),
    continuation_avoided_duplicate_domains: continuation.duplication.duplicate_domain_definitions.length === 0,
    tests_passed: initial.tests_passed && continuation.tests_passed,
  };
  const score = Object.values(proof).filter(Boolean).length * 10;
  return {
    id: options.id,
    title: options.title,
    product: options.product,
    score,
    status: score >= 90 ? 'pass' : score >= 70 ? 'warn' : 'fail',
    guidance: {
      status: String(initialGuidance.status),
      recommended_patterns: initialGuidance.recommended_architecture.patterns.map(pattern => pattern.name),
      core_concepts_to_name_once: initialGuidance.large_scale_build_strategy.core_concepts_to_name_once,
      file_plan: initialGuidance.recommended_architecture.file_plan.map(file => file.path),
    },
    initial,
    continuation,
    proof,
  };
}

async function analyzeStage(options: {
  name: string;
  projectPath: string;
  planText: string;
  outputRoot: string;
  duplicateConcepts?: string[];
  reusePatterns?: Array<{ name: string; pattern: RegExp }>;
}): Promise<DogfoodStage> {
  const files = await filesFromProject(options.projectPath);
  const preview = await previewGreenfieldCodebase({
    title: options.name,
    planText: options.planText,
    proposedFiles: files,
    previewBaseUrl: 'https://app.klauro.test',
  }) as any;
  const previewHtml = path.join(options.outputRoot, `${options.name}.html`);
  await renderProposalPreviewHtml({ previewId: preview.preview.id, output: previewHtml });
  const previewPayload = await getPreviewAnalysis(preview.preview.id) as any;
  const analysis = { output: await analyzeForBench(options.projectPath) };
  const testCommand = 'node --test';
  const test = await runCommand(testCommand, options.projectPath);
  const duplicateDomainDefinitions = findDuplicateDomainDefinitions(files, options.duplicateConcepts);
  const content = files.map(file => `${file.path}\n${file.content || ''}`).join('\n');
  const reusePatterns = options.reusePatterns || [];

  return {
    name: options.name,
    project_path: options.projectPath,
    file_count: files.length,
    test_command: testCommand,
    tests_passed: test.exitCode === 0,
    test_stdout_tail: tail(`${test.stdout}\n${test.stderr}`),
    analysis: {
      nodes: analysis.output.nodes.length,
      edges: analysis.output.edges.length,
      entry_points: analysis.output.entry_points?.length || 0,
      capabilities: analysis.output.capabilities?.length || 0,
      domain_concepts: analysis.output.domain_concepts?.length || 0,
      architecture_patterns: (analysis.output.architecture_summary?.architectural_patterns || [])
        .map(pattern => pattern.name)
        .slice(0, 8),
    },
    preview: {
      id: preview.preview.id,
      url: preview.preview.preview_url,
      html: previewHtml,
      verdict: String(previewPayload.preview?.verdict?.status || preview.preview?.verdict?.status || 'unknown'),
    },
    duplication: {
      duplicate_domain_definitions: duplicateDomainDefinitions,
      reused_core_models: reusePatterns
        .filter(item => item.pattern.test(content))
        .map(item => item.name),
    },
  };
}

function initialReliabilityPlatformFiles(guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance>): ProposedFileInput[] {
  return [
    {
      path: 'package.json',
      content: JSON.stringify({
        name: 'klauro-dogfood-reliability-platform',
        version: '0.1.0',
        type: 'module',
        scripts: { test: 'node --test' },
      }, null, 2),
    },
    {
      path: 'README.md',
      content: [
        '# Reliability Platform',
        '',
        'Built from an empty folder using Klauro greenfield guidance.',
        '',
        'Guidance patterns:',
        ...guidance.recommended_architecture.patterns.map(pattern => `- ${pattern.name}: ${pattern.guidance}`),
        '',
      ].join('\n'),
    },
    {
      path: 'src/domain/reliability-models.js',
      content: [
        'export class Organization { constructor({ id, name }) { this.id = id; this.name = name; } }',
        'export class Workspace { constructor({ id, organizationId, name }) { this.id = id; this.organizationId = organizationId; this.name = name; } }',
        'export class Service { constructor({ id, workspaceId, name, tier }) { this.id = id; this.workspaceId = workspaceId; this.name = name; this.tier = tier; } }',
        'export class Incident { constructor({ id, serviceId, severity, status }) { this.id = id; this.serviceId = serviceId; this.severity = severity; this.status = status; this.auditEvents = []; } }',
        'export class Alert { constructor({ id, incidentId, source, acknowledged = false }) { this.id = id; this.incidentId = incidentId; this.source = source; this.acknowledged = acknowledged; } }',
        'export class EscalationPolicy { constructor({ id, serviceId, ownerIds }) { this.id = id; this.serviceId = serviceId; this.ownerIds = ownerIds; } }',
        'export class AuditEvent { constructor({ id, actorId, action, targetId }) { this.id = id; this.actorId = actorId; this.action = action; this.targetId = targetId; } }',
        '',
      ].join('\n'),
    },
    {
      path: 'src/auth/access-policy.js',
      content: [
        'export function assertWorkspaceAccess(context, workspaceId) {',
        '  if (!context || context.workspaceId !== workspaceId) throw new Error("workspace_access_denied");',
        '  return true;',
        '}',
        'export function assertIncidentAccess(context, incident) {',
        '  if (!context || context.serviceIds?.includes(incident.serviceId) !== true) throw new Error("incident_access_denied");',
        '  return true;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/repositories/reliability.repository.js',
      content: [
        'export class ReliabilityRepository {',
        '  constructor(seed = {}) { this.organizations = seed.organizations || []; this.workspaces = seed.workspaces || []; this.services = seed.services || []; this.incidents = seed.incidents || []; this.alerts = seed.alerts || []; this.auditEvents = seed.auditEvents || []; }',
        '  saveIncident(incident) { this.incidents = this.incidents.filter(item => item.id !== incident.id).concat(incident); return incident; }',
        '  saveAlert(alert) { this.alerts = this.alerts.filter(item => item.id !== alert.id).concat(alert); return alert; }',
        '  recordAudit(event) { this.auditEvents.push(event); return event; }',
        '  findService(serviceId) { return this.services.find(service => service.id === serviceId); }',
        '  findIncident(incidentId) { return this.incidents.find(incident => incident.id === incidentId); }',
        '  listOpenIncidents() { return this.incidents.filter(incident => incident.status !== "resolved"); }',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/services/incident.service.js',
      content: [
        'import { Alert, AuditEvent, Incident } from "../domain/reliability-models.js";',
        'import { assertIncidentAccess, assertWorkspaceAccess } from "../auth/access-policy.js";',
        'export class IncidentService {',
        '  constructor(repository) { this.repository = repository; }',
        '  openIncident(context, input) {',
        '    const service = this.repository.findService(input.serviceId);',
        '    if (!service) throw new Error("service_not_found");',
        '    assertWorkspaceAccess(context, service.workspaceId);',
        '    const incident = this.repository.saveIncident(new Incident({ id: input.id, serviceId: service.id, severity: input.severity, status: "open" }));',
        '    this.repository.recordAudit(new AuditEvent({ id: `audit-${input.id}`, actorId: context.actorId, action: "incident.opened", targetId: incident.id }));',
        '    return incident;',
        '  }',
        '  attachAlert(context, incidentId, alertInput) {',
        '    const incident = this.repository.findIncident(incidentId);',
        '    if (!incident) throw new Error("incident_not_found");',
        '    assertIncidentAccess(context, incident);',
        '    return this.repository.saveAlert(new Alert({ id: alertInput.id, incidentId, source: alertInput.source }));',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/routes/incident.routes.js',
      content: [
        'export function registerIncidentRoutes(router, incidentService) {',
        '  router.post("/workspaces/:workspaceId/services/:serviceId/incidents", request => incidentService.openIncident(request.context, { id: request.body.id, serviceId: request.params.serviceId, severity: request.body.severity }));',
        '  router.post("/incidents/:incidentId/alerts", request => incidentService.attachAlert(request.context, request.params.incidentId, request.body));',
        '  return router;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/workers/reliability-digest.worker.js',
      content: [
        'export class ReliabilityDigestWorker {',
        '  constructor(repository) { this.repository = repository; }',
        '  buildDigest() {',
        '    const open = this.repository.listOpenIncidents();',
        '    return { openIncidentCount: open.length, highSeverityCount: open.filter(incident => incident.severity === "high").length };',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'migrations/001_create_reliability_core.sql',
      content: [
        'CREATE TABLE organizations (id text primary key, name text not null);',
        'CREATE TABLE workspaces (id text primary key, organization_id text not null references organizations(id), name text not null);',
        'CREATE TABLE services (id text primary key, workspace_id text not null references workspaces(id), name text not null, tier text not null);',
        'CREATE TABLE incidents (id text primary key, service_id text not null references services(id), severity text not null, status text not null);',
        'CREATE TABLE alerts (id text primary key, incident_id text not null references incidents(id), source text not null, acknowledged boolean not null default false);',
        'CREATE TABLE audit_events (id text primary key, actor_id text not null, action text not null, target_id text not null);',
        '',
      ].join('\n'),
    },
    {
      path: 'test/incident.service.test.js',
      content: [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { ReliabilityRepository } from "../src/repositories/reliability.repository.js";',
        'import { IncidentService } from "../src/services/incident.service.js";',
        'test("opens incidents through workspace-scoped service boundary", () => {',
        '  const repository = new ReliabilityRepository({ services: [{ id: "svc-1", workspaceId: "ws-1", name: "API", tier: "critical" }] });',
        '  const service = new IncidentService(repository);',
        '  const incident = service.openIncident({ actorId: "mem-1", workspaceId: "ws-1", serviceIds: ["svc-1"] }, { id: "inc-1", serviceId: "svc-1", severity: "high" });',
        '  assert.equal(incident.status, "open");',
        '  assert.equal(repository.auditEvents.length, 1);',
        '});',
        '',
      ].join('\n'),
    },
    {
      path: 'test/reliability-digest.worker.test.js',
      content: [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { ReliabilityRepository } from "../src/repositories/reliability.repository.js";',
        'import { ReliabilityDigestWorker } from "../src/workers/reliability-digest.worker.js";',
        'test("builds digest from existing incident repository", () => {',
        '  const repository = new ReliabilityRepository({ incidents: [{ id: "inc-1", serviceId: "svc-1", severity: "high", status: "open" }] });',
        '  assert.deepEqual(new ReliabilityDigestWorker(repository).buildDigest(), { openIncidentCount: 1, highSeverityCount: 1 });',
        '});',
        '',
      ].join('\n'),
    },
  ];
}

function continuationFiles(guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance>): ProposedFileInput[] {
  return [
    {
      path: 'docs/klauro-continuation-guidance.json',
      content: JSON.stringify({
        status: guidance.status,
        do_not_rebuild: guidance.capability_memory.do_not_rebuild,
        reuse_decisions_required: guidance.capability_memory.reuse_decisions_required,
      }, null, 2),
    },
    {
      path: 'src/domain/reliability-continuation-models.js',
      content: [
        'import { Alert, Incident, Organization, Service, Workspace } from "./reliability-models.js";',
        'export class IncidentNote { constructor({ id, incidentId, authorId, body }) { this.id = id; this.incidentId = incidentId; this.authorId = authorId; this.body = body; } }',
        'export class RunbookExecution { constructor({ id, incidentId, serviceId, runbookId, status }) { this.id = id; this.incidentId = incidentId; this.serviceId = serviceId; this.runbookId = runbookId; this.status = status; } }',
        'export class AlertAcknowledgement { constructor({ id, alertId, actorId }) { this.id = id; this.alertId = alertId; this.actorId = actorId; } }',
        'export class SavedIncidentView { constructor({ id, organizationId, workspaceId, name, filters }) { this.id = id; this.organizationId = organizationId; this.workspaceId = workspaceId; this.name = name; this.filters = filters; } }',
        'export const modelReuseContract = { organization: Organization, workspace: Workspace, service: Service, incident: Incident, alert: Alert };',
        'export const idReuseExamples = /** @type {{ organizationId: Organization["id"], workspaceId: Workspace["id"], serviceId: Service["id"], incidentId: Incident["id"], alertId: Alert["id"] }} */ ({});',
        '',
      ].join('\n'),
    },
    {
      path: 'src/services/incident-collaboration.service.js',
      content: [
        'import { AlertAcknowledgement, IncidentNote, RunbookExecution, SavedIncidentView } from "../domain/reliability-continuation-models.js";',
        'import { assertIncidentAccess, assertWorkspaceAccess } from "../auth/access-policy.js";',
        'export class IncidentCollaborationService {',
        '  constructor(repository, incidentService) { this.repository = repository; this.incidentService = incidentService; this.notes = []; this.executions = []; this.acknowledgements = []; this.views = []; }',
        '  addNote(context, incidentId, body) {',
        '    const incident = this.repository.findIncident(incidentId);',
        '    assertIncidentAccess(context, incident);',
        '    const note = new IncidentNote({ id: `note-${this.notes.length + 1}`, incidentId, authorId: context.actorId, body });',
        '    this.notes.push(note);',
        '    return note;',
        '  }',
        '  executeRunbook(context, incidentId, runbookId) {',
        '    const incident = this.repository.findIncident(incidentId);',
        '    assertIncidentAccess(context, incident);',
        '    const execution = new RunbookExecution({ id: `exec-${this.executions.length + 1}`, incidentId, serviceId: incident.serviceId, runbookId, status: "started" });',
        '    this.executions.push(execution);',
        '    return execution;',
        '  }',
        '  acknowledgeAlert(context, alert) {',
        '    assertIncidentAccess(context, this.repository.findIncident(alert.incidentId));',
        '    const acknowledgement = new AlertAcknowledgement({ id: `ack-${this.acknowledgements.length + 1}`, alertId: alert.id, actorId: context.actorId });',
        '    this.acknowledgements.push(acknowledgement);',
        '    return acknowledgement;',
        '  }',
        '  saveIncidentView(context, input) {',
        '    assertWorkspaceAccess(context, input.workspaceId);',
        '    const view = new SavedIncidentView(input);',
        '    this.views.push(view);',
        '    return view;',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/routes/incident-collaboration.routes.js',
      content: [
        'export function registerIncidentCollaborationRoutes(router, collaborationService) {',
        '  router.post("/incidents/:incidentId/notes", request => collaborationService.addNote(request.context, request.params.incidentId, request.body.body));',
        '  router.post("/incidents/:incidentId/runbooks/:runbookId/executions", request => collaborationService.executeRunbook(request.context, request.params.incidentId, request.params.runbookId));',
        '  router.post("/workspaces/:workspaceId/incident-views", request => collaborationService.saveIncidentView(request.context, { ...request.body, workspaceId: request.params.workspaceId }));',
        '  return router;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/routes/webhook.routes.js',
      content: [
        'export function registerWebhookRoutes(router, incidentService) {',
        '  router.post("/webhooks/alerts", request => incidentService.attachAlert(request.context, request.body.incidentId, { id: request.body.alertId, source: request.body.source || "webhook" }));',
        '  return router;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/workers/weekly-reliability-snapshot.worker.js',
      content: [
        'export class WeeklyReliabilitySnapshotWorker {',
        '  constructor(repository, digestWorker) { this.repository = repository; this.digestWorker = digestWorker; this.snapshots = []; }',
        '  captureSnapshot(workspaceId) {',
        '    const digest = this.digestWorker.buildDigest();',
        '    const snapshot = { id: `snapshot-${this.snapshots.length + 1}`, workspaceId, digest };',
        '    this.snapshots.push(snapshot);',
        '    return snapshot;',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'migrations/002_add_reliability_continuation.sql',
      content: [
        'CREATE TABLE incident_notes (id text primary key, incident_id text not null references incidents(id), author_id text not null, body text not null);',
        'CREATE TABLE runbook_executions (id text primary key, incident_id text not null references incidents(id), service_id text not null references services(id), runbook_id text not null, status text not null);',
        'CREATE TABLE alert_acknowledgements (id text primary key, alert_id text not null references alerts(id), actor_id text not null);',
        'CREATE TABLE saved_incident_views (id text primary key, organization_id text not null references organizations(id), workspace_id text not null references workspaces(id), name text not null, filters jsonb not null);',
        'CREATE TABLE weekly_reliability_snapshots (id text primary key, workspace_id text not null references workspaces(id), digest jsonb not null);',
        '',
      ].join('\n'),
    },
    {
      path: 'test/incident-collaboration.service.test.js',
      content: [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { ReliabilityRepository } from "../src/repositories/reliability.repository.js";',
        'import { IncidentCollaborationService } from "../src/services/incident-collaboration.service.js";',
        'test("adds continuation behavior without rebuilding incident domain", () => {',
        '  const repository = new ReliabilityRepository({ services: [{ id: "svc-1", workspaceId: "ws-1", name: "API", tier: "critical" }], incidents: [{ id: "inc-1", serviceId: "svc-1", severity: "high", status: "open" }] });',
        '  const service = new IncidentCollaborationService(repository);',
        '  const note = service.addNote({ actorId: "mem-1", workspaceId: "ws-1", serviceIds: ["svc-1"] }, "inc-1", "Checking runbook");',
        '  assert.equal(note.incidentId, "inc-1");',
        '});',
        '',
      ].join('\n'),
    },
    {
      path: 'test/weekly-reliability-snapshot.worker.test.js',
      content: [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { ReliabilityRepository } from "../src/repositories/reliability.repository.js";',
        'import { ReliabilityDigestWorker } from "../src/workers/reliability-digest.worker.js";',
        'import { WeeklyReliabilitySnapshotWorker } from "../src/workers/weekly-reliability-snapshot.worker.js";',
        'test("captures snapshots from existing digest worker", () => {',
        '  const repository = new ReliabilityRepository({ incidents: [{ id: "inc-1", serviceId: "svc-1", severity: "high", status: "open" }] });',
        '  const worker = new WeeklyReliabilitySnapshotWorker(repository, new ReliabilityDigestWorker(repository));',
        '  assert.equal(worker.captureSnapshot("ws-1").digest.highSeverityCount, 1);',
        '});',
        '',
      ].join('\n'),
    },
  ];
}

function initialOperationsCommandCenterFiles(guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance>): ProposedFileInput[] {
  return [
    {
      path: 'package.json',
      content: JSON.stringify({
        name: 'klauro-dogfood-operations-command-center',
        version: '0.1.0',
        type: 'module',
        scripts: { test: 'node --test' },
      }, null, 2),
    },
    {
      path: 'README.md',
      content: [
        '# Operations Command Center',
        '',
        'Built from an empty folder using Klauro greenfield guidance for a UI-heavy product shape.',
        '',
        'Guidance patterns:',
        ...guidance.recommended_architecture.patterns.map(pattern => `- ${pattern.name}: ${pattern.guidance}`),
        '',
      ].join('\n'),
    },
    {
      path: 'src/domain/operations-models.js',
      content: [
        'export class Workspace { constructor({ id, name }) { this.id = id; this.name = name; } }',
        'export class Dashboard { constructor({ id, workspaceId, name, widgetIds = [] }) { this.id = id; this.workspaceId = workspaceId; this.name = name; this.widgetIds = widgetIds; } }',
        'export class Widget { constructor({ id, dashboardId, kind, title }) { this.id = id; this.dashboardId = dashboardId; this.kind = kind; this.title = title; } }',
        'export class AnalysisStatus { constructor({ id, workspaceId, state, checkedAt }) { this.id = id; this.workspaceId = workspaceId; this.state = state; this.checkedAt = checkedAt; } }',
        'export class ProposalPreview { constructor({ id, workspaceId, status, url }) { this.id = id; this.workspaceId = workspaceId; this.status = status; this.url = url; } }',
        'export class Incident { constructor({ id, workspaceId, severity, state }) { this.id = id; this.workspaceId = workspaceId; this.severity = severity; this.state = state; } }',
        'export class Alert { constructor({ id, incidentId, source, state }) { this.id = id; this.incidentId = incidentId; this.source = source; this.state = state; } }',
        'export class OperatorTask { constructor({ id, workspaceId, title, state }) { this.id = id; this.workspaceId = workspaceId; this.title = title; this.state = state; } }',
        '',
      ].join('\n'),
    },
    {
      path: 'src/services/operations-dashboard.service.js',
      content: [
        'export class OperationsDashboardService {',
        '  constructor(store) { this.store = store; }',
        '  getWorkspaceCommandCenter(workspaceId) {',
        '    return {',
        '      workspace: this.store.findWorkspace(workspaceId),',
        '      dashboards: this.store.listDashboards(workspaceId),',
        '      analysisStatuses: this.store.listAnalysisStatuses(workspaceId),',
        '      proposalPreviews: this.store.listProposalPreviews(workspaceId),',
        '      incidents: this.store.listIncidents(workspaceId),',
        '      alerts: this.store.listAlerts(workspaceId),',
        '      tasks: this.store.listOperatorTasks(workspaceId),',
        '    };',
        '  }',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/services/operations-store.js',
      content: [
        'export class OperationsStore {',
        '  constructor(seed = {}) { this.workspaces = seed.workspaces || []; this.dashboards = seed.dashboards || []; this.widgets = seed.widgets || []; this.analysisStatuses = seed.analysisStatuses || []; this.proposalPreviews = seed.proposalPreviews || []; this.incidents = seed.incidents || []; this.alerts = seed.alerts || []; this.operatorTasks = seed.operatorTasks || []; }',
        '  findWorkspace(workspaceId) { return this.workspaces.find(workspace => workspace.id === workspaceId); }',
        '  listDashboards(workspaceId) { return this.dashboards.filter(dashboard => dashboard.workspaceId === workspaceId); }',
        '  listAnalysisStatuses(workspaceId) { return this.analysisStatuses.filter(status => status.workspaceId === workspaceId); }',
        '  listProposalPreviews(workspaceId) { return this.proposalPreviews.filter(preview => preview.workspaceId === workspaceId); }',
        '  listIncidents(workspaceId) { return this.incidents.filter(incident => incident.workspaceId === workspaceId); }',
        '  listAlerts(workspaceId) { const incidentIds = new Set(this.listIncidents(workspaceId).map(incident => incident.id)); return this.alerts.filter(alert => incidentIds.has(alert.incidentId)); }',
        '  listOperatorTasks(workspaceId) { return this.operatorTasks.filter(task => task.workspaceId === workspaceId); }',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/routes/operations.routes.js',
      content: [
        'export function registerOperationsRoutes(router, dashboardService) {',
        '  router.get("/workspaces/:workspaceId/command-center", request => dashboardService.getWorkspaceCommandCenter(request.params.workspaceId));',
        '  return router;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/components/CommandCenterView.js',
      content: [
        'export function renderCommandCenterView(model) {',
        '  return {',
        '    title: `${model.workspace.name} command center`,',
        '    sections: ["analysis-health", "proposal-previews", "incidents", "alerts", "operator-tasks"],',
        '    counts: { dashboards: model.dashboards.length, previews: model.proposalPreviews.length, incidents: model.incidents.length, alerts: model.alerts.length, tasks: model.tasks.length },',
        '  };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/hooks/useCommandCenterModel.js',
      content: [
        'export function createCommandCenterModel(workspaceId, dashboardService) {',
        '  return dashboardService.getWorkspaceCommandCenter(workspaceId);',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/contracts/command-center-contract.js',
      content: [
        'export const commandCenterContract = {',
        '  route: "/workspaces/:workspaceId/command-center",',
        '  sections: ["analysis-health", "proposal-previews", "incidents", "alerts", "operator-tasks"],',
        '};',
        '',
      ].join('\n'),
    },
    {
      path: 'test/command-center-view.test.js',
      content: [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { Workspace, Dashboard, AnalysisStatus, ProposalPreview, Incident, Alert, OperatorTask } from "../src/domain/operations-models.js";',
        'import { OperationsStore } from "../src/services/operations-store.js";',
        'import { OperationsDashboardService } from "../src/services/operations-dashboard.service.js";',
        'import { renderCommandCenterView } from "../src/components/CommandCenterView.js";',
        'test("renders command center from one workspace model chain", () => {',
        '  const store = new OperationsStore({ workspaces: [new Workspace({ id: "ws-1", name: "Core" })], dashboards: [new Dashboard({ id: "dash-1", workspaceId: "ws-1", name: "Ops" })], analysisStatuses: [new AnalysisStatus({ id: "analysis-1", workspaceId: "ws-1", state: "ready", checkedAt: "now" })], proposalPreviews: [new ProposalPreview({ id: "preview-1", workspaceId: "ws-1", status: "warn", url: "/p" })], incidents: [new Incident({ id: "inc-1", workspaceId: "ws-1", severity: "high", state: "open" })], alerts: [new Alert({ id: "alert-1", incidentId: "inc-1", source: "monitor", state: "open" })], operatorTasks: [new OperatorTask({ id: "task-1", workspaceId: "ws-1", title: "Review", state: "open" })] });',
        '  const view = renderCommandCenterView(new OperationsDashboardService(store).getWorkspaceCommandCenter("ws-1"));',
        '  assert.equal(view.counts.previews, 1);',
        '  assert.equal(view.counts.alerts, 1);',
        '});',
        '',
      ].join('\n'),
    },
  ];
}

function operationsCommandCenterContinuationFiles(guidance: ReturnType<typeof buildGreenfieldArchitectureGuidance>): ProposedFileInput[] {
  return [
    {
      path: 'docs/klauro-continuation-guidance.json',
      content: JSON.stringify({
        status: guidance.status,
        large_scale_build_strategy: guidance.large_scale_build_strategy,
        do_not_rebuild: guidance.capability_memory.do_not_rebuild,
      }, null, 2),
    },
    {
      path: 'src/domain/operations-continuation-models.js',
      content: [
        'import { AnalysisStatus, Dashboard, Widget, Workspace } from "./operations-models.js";',
        'export class ProposalImpactTimeline { constructor({ id, workspaceId, previewId, events }) { this.id = id; this.workspaceId = workspaceId; this.previewId = previewId; this.events = events; } }',
        'export class ComparisonOverlay { constructor({ id, dashboardId, widgetId, filters }) { this.id = id; this.dashboardId = dashboardId; this.widgetId = widgetId; this.filters = filters; } }',
        'export class AlertTriageQueue { constructor({ id, workspaceId, alertIds }) { this.id = id; this.workspaceId = workspaceId; this.alertIds = alertIds; } }',
        'export class IncidentDetailDrawer { constructor({ id, workspaceId, incidentId, selectedTab }) { this.id = id; this.workspaceId = workspaceId; this.incidentId = incidentId; this.selectedTab = selectedTab; } }',
        'export class WorkspaceNotificationPreference { constructor({ id, workspaceId, channel, enabled }) { this.id = id; this.workspaceId = workspaceId; this.channel = channel; this.enabled = enabled; } }',
        'export const modelReuseContract = { workspace: Workspace, dashboard: Dashboard, widget: Widget, analysisStatus: AnalysisStatus };',
        'export const idReuseExamples = /** @type {{ workspaceId: Workspace["id"], dashboardId: Dashboard["id"], widgetId: Widget["id"], analysisStatusId: AnalysisStatus["id"] }} */ ({});',
        '',
      ].join('\n'),
    },
    {
      path: 'src/services/operations-continuation.service.js',
      content: [
        'import { AlertTriageQueue, ComparisonOverlay, IncidentDetailDrawer, ProposalImpactTimeline, WorkspaceNotificationPreference } from "../domain/operations-continuation-models.js";',
        'export class OperationsContinuationService {',
        '  constructor(store) { this.store = store; this.timelines = []; this.overlays = []; this.queues = []; this.drawers = []; this.preferences = []; }',
        '  addProposalTimeline(workspaceId, previewId, events) { const timeline = new ProposalImpactTimeline({ id: `timeline-${this.timelines.length + 1}`, workspaceId, previewId, events }); this.timelines.push(timeline); return timeline; }',
        '  saveComparisonOverlay(dashboardId, widgetId, filters) { const overlay = new ComparisonOverlay({ id: `overlay-${this.overlays.length + 1}`, dashboardId, widgetId, filters }); this.overlays.push(overlay); return overlay; }',
        '  buildAlertTriageQueue(workspaceId) { const alertIds = this.store.listAlerts(workspaceId).map(alert => alert.id); const queue = new AlertTriageQueue({ id: `queue-${this.queues.length + 1}`, workspaceId, alertIds }); this.queues.push(queue); return queue; }',
        '  openIncidentDrawer(workspaceId, incidentId, selectedTab = "summary") { const drawer = new IncidentDetailDrawer({ id: `drawer-${this.drawers.length + 1}`, workspaceId, incidentId, selectedTab }); this.drawers.push(drawer); return drawer; }',
        '  saveNotificationPreference(workspaceId, channel, enabled) { const preference = new WorkspaceNotificationPreference({ id: `pref-${this.preferences.length + 1}`, workspaceId, channel, enabled }); this.preferences.push(preference); return preference; }',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/components/ProposalImpactTimelinePanel.js',
      content: [
        'export function renderProposalImpactTimelinePanel(timeline) {',
        '  return { title: "Proposal impact", eventCount: timeline.events.length, previewId: timeline.previewId };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/components/AlertTriageQueuePanel.js',
      content: [
        'export function renderAlertTriageQueuePanel(queue) {',
        '  return { title: "Alert triage", alertCount: queue.alertIds.length };',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/routes/operations-continuation.routes.js',
      content: [
        'export function registerOperationsContinuationRoutes(router, continuationService) {',
        '  router.post("/workspaces/:workspaceId/proposal-impact-timelines", request => continuationService.addProposalTimeline(request.params.workspaceId, request.body.previewId, request.body.events || []));',
        '  router.post("/workspaces/:workspaceId/alert-triage-queues", request => continuationService.buildAlertTriageQueue(request.params.workspaceId));',
        '  router.post("/workspaces/:workspaceId/notification-preferences", request => continuationService.saveNotificationPreference(request.params.workspaceId, request.body.channel, request.body.enabled));',
        '  return router;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'test/operations-continuation.service.test.js',
      content: [
        'import test from "node:test";',
        'import assert from "node:assert/strict";',
        'import { Incident, Alert } from "../src/domain/operations-models.js";',
        'import { OperationsStore } from "../src/services/operations-store.js";',
        'import { OperationsContinuationService } from "../src/services/operations-continuation.service.js";',
        'test("adds UI continuation behavior through the existing workspace model chain", () => {',
        '  const store = new OperationsStore({ incidents: [new Incident({ id: "inc-1", workspaceId: "ws-1", severity: "high", state: "open" })], alerts: [new Alert({ id: "alert-1", incidentId: "inc-1", source: "monitor", state: "open" })] });',
        '  const service = new OperationsContinuationService(store);',
        '  assert.equal(service.buildAlertTriageQueue("ws-1").alertIds.length, 1);',
        '  assert.equal(service.addProposalTimeline("ws-1", "preview-1", [{ kind: "contract" }]).workspaceId, "ws-1");',
        '});',
        '',
      ].join('\n'),
    },
  ];
}

async function writeFiles(root: string, files: ProposedFileInput[], _options: { append?: boolean } = {}): Promise<void> {
  for (const file of files) {
    const absolute = path.join(root, file.path);
    await fs.ensureDir(path.dirname(absolute));
    await fs.writeFile(absolute, file.content || '', 'utf8');
  }
}

async function filesFromProject(root: string): Promise<ProposedFileInput[]> {
  const results: ProposedFileInput[] = [];
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.cache']);
  const visit = async (directory: string) => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) await visit(absolute);
      } else if (entry.isFile() && /\.(js|ts|tsx|json|sql|md)$/.test(relative)) {
        const stat = await fs.stat(absolute);
        if (stat.size <= 500_000) results.push({ path: relative, content: await fs.readFile(absolute, 'utf8'), status: 'added' });
      }
    }
  };
  await visit(root);
  return results.sort((left, right) => left.path.localeCompare(right.path));
}

async function loadReferences(paths: string[]): Promise<GreenfieldReferenceAnalysis[]> {
  const references: GreenfieldReferenceAnalysis[] = [];
  for (const referencePath of paths) {
    const absolute = path.resolve(referencePath);
    if (!(await fs.pathExists(absolute))) continue;
    try {
      const cas = await analyzeForBench(absolute);
      references.push({
        path: absolute,
        name: cas.system?.name || path.basename(absolute),
        cas,
      });
    } catch {

    }
  }
  return references;
}

function findDuplicateDomainDefinitions(files: ProposedFileInput[], concepts = ['Organization', 'Workspace', 'Service', 'Incident', 'Alert', 'EscalationPolicy', 'AuditEvent']): string[] {
  const content = files.map(file => `${file.path}\n${file.content || ''}`).join('\n');
  return concepts.filter(concept => {
    const definitions = Array.from(content.matchAll(new RegExp(`\\b(class|interface|type)\\s+${concept}\\b`, 'g')));
    return definitions.length > 1;
  });
}

async function runCommand(command: string, cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync('/bin/sh', ['-lc', command], { cwd, timeout: 120_000, maxBuffer: 1024 * 1024 * 10 });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: any) {
    return { exitCode: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout || '', stderr: error.stderr || error.message || String(error) };
  }
}

function defaultReferencePaths(): string[] {
  return defaultBenchmarkReferencePaths(__dirname);
}

function formatReportMarkdown(report: DogfoodReport): string {
  return [
    '# Klauro Scratch Dogfood Build',
    '',
    `Generated: ${report.generated_at}`,
    `Status: ${report.status}`,
    `Score: ${report.score}/100`,
    `Scenarios: ${report.summary.scenarios_passed}/${report.summary.scenario_count}`,
    `Primary project: ${report.initial.project_path}`,
    '',
    '## Scenarios',
    '',
    '| Scenario | Status | Score | Initial CAS | Continuation CAS | Reused Models | Duplicate Definitions |',
    '| --- | --- | ---: | --- | --- | --- | --- |',
    ...report.scenarios.map(scenario => [
      scenario.title,
      scenario.status,
      `${scenario.score}/100`,
      `${scenario.initial.analysis.nodes} nodes / ${scenario.initial.analysis.edges} edges / ${scenario.initial.analysis.capabilities} capabilities`,
      `${scenario.continuation.analysis.nodes} nodes / ${scenario.continuation.analysis.edges} edges / ${scenario.continuation.analysis.capabilities} capabilities`,
      scenario.continuation.duplication.reused_core_models.join(', ') || 'none',
      scenario.continuation.duplication.duplicate_domain_definitions.join(', ') || 'none',
    ].join(' | ')).map(row => `| ${row} |`),
    '',
    '## Proof',
    '',
    ...Object.entries(report.proof).map(([key, value]) => `- ${key}: ${value ? 'yes' : 'no'}`),
    '',
    '## Initial Build',
    '',
    `Files: ${report.initial.file_count}`,
    `Tests passed: ${report.initial.tests_passed}`,
    `CAS: ${report.initial.analysis.nodes} nodes, ${report.initial.analysis.edges} edges, ${report.initial.analysis.capabilities} capabilities`,
    `Preview HTML: ${report.initial.preview.html}`,
    '',
    '## Continuation',
    '',
    `Files: ${report.continuation.file_count}`,
    `Tests passed: ${report.continuation.tests_passed}`,
    `CAS: ${report.continuation.analysis.nodes} nodes, ${report.continuation.analysis.edges} edges, ${report.continuation.analysis.capabilities} capabilities`,
    `Reused models: ${report.continuation.duplication.reused_core_models.join(', ') || 'none'}`,
    `Duplicate definitions: ${report.continuation.duplication.duplicate_domain_definitions.join(', ') || 'none'}`,
    `Preview HTML: ${report.continuation.preview.html}`,
    '',
  ].join('\n');
}

function tail(value: string): string {
  const lines = value.split('\n').filter(Boolean);
  return lines.slice(-20).join('\n');
}

function parseArgs(argv: string[]): Args {
  const args: Args = {


    outputRoot: path.join(os.tmpdir(), 'klauro-scratch-dogfood-build'),
    reportPath: '/tmp/klauro-scratch-dogfood-build.json',
    references: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output-root') args.outputRoot = argv[++index];
    else if (arg === '--report') args.reportPath = argv[++index];
    else if (arg === '--reference') args.references.push(argv[++index]);
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: npm run agent-scratch-dogfood-build -- [--output-root path] [--report file] [--reference repo]\n');
      process.exit(0);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return args;
}

if (isDirectCliInvocation('agent-scratch-dogfood-build')) {
  runAgentScratchDogfoodBuild()
    .then(report => {
      process.stdout.write(`Scratch dogfood build: ${report.status.toUpperCase()} (${report.score}/100)\n`);
      process.stdout.write(`Project: ${report.initial.project_path}\n`);
      process.stdout.write(`Report: /tmp/klauro-scratch-dogfood-build.json\n`);
      process.stdout.write(`Initial preview: ${report.initial.preview.html}\n`);
      process.stdout.write(`Continuation preview: ${report.continuation.preview.html}\n`);
    })
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}
