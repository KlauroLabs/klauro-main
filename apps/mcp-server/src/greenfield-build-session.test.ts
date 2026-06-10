import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { buildGreenfieldBuildPacket } from './greenfield-build-session';

test('greenfield build packet starts from a truly empty folder without source exploration', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-empty-greenfield-'));
  const packet = await buildGreenfieldBuildPacket({
    workspacePath: workspace,
    planText: 'Build a multi-tenant incident operations platform with dashboards, alerts, escalation policies, tests, and audit history.',
    references: [],
  });

  assert.equal(packet.product, 'greenfield_build_packet');
  assert.equal(packet.stage, 'empty_workspace_first_slice');
  assert.equal(packet.current_analysis, null);
  assert.equal(packet.architecture_memory.stage, 'no_code_yet');
  assert.ok(packet.architecture_memory.decision_ledger.some((item: any) => item.decision.includes('Name core domain concepts once')));
  assert.match(packet.product_focus.objective, /product behavior/);
  assert.ok(packet.product_focus.agent_should_not_spend_time_on.some((item: string) => item.includes('empty folder')));
  assert.ok(packet.product_focus.next_product_slice_definition.includes('vertical slice'));
  assert.equal(packet.growth_control_plane.mode, 'first_slice_bootstrap');
  assert.match(packet.growth_control_plane.purpose, /agent can spend more effort on product behavior/);
  assert.equal(packet.growth_control_plane.context_budget.max_first_reads, 0);
  assert.ok(packet.growth_control_plane.product_slice.done_when.some((item: string) => item.includes('Core domain concepts are named once')));
  assert.ok(packet.growth_control_plane.next_klauro_loop.some((item: string) => item.includes('preview_greenfield_codebase')));
  assert.match(packet.context_budget.token_rule, /Do not spend tokens exploring the empty folder/);
  assert.ok(packet.next_agent_steps.some(step => step.includes('vertical slice')));
  assert.ok(packet.validation_plan.klauro_checks.includes('preview_greenfield_codebase'));
});

test('greenfield build packet turns an existing scratch project into CAS-backed continuation memory', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-growing-greenfield-'));
  await fs.outputJson(path.join(workspace, 'package.json'), {
    scripts: { test: 'node --test src/*.test.js' },
    dependencies: {},
    devDependencies: {},
  });
  await fs.outputFile(path.join(workspace, 'src/domain.ts'), `
export interface Workspace { id: string; name: string; }
export interface Dashboard { id: string; workspaceId: Workspace['id']; title: string; }
export interface Widget { id: string; dashboardId: Dashboard['id']; kind: 'health' | 'risk'; }
`);
  await fs.outputFile(path.join(workspace, 'src/dashboard-service.ts'), `
import type { Dashboard, Widget, Workspace } from './domain';
export function listWorkspaceDashboards(workspace: Workspace, dashboards: Dashboard[]) {
  return dashboards.filter(dashboard => dashboard.workspaceId === workspace.id);
}
export function attachWidget(dashboard: Dashboard, widget: Widget) {
  return widget.dashboardId === dashboard.id;
}
`);
  await fs.outputFile(path.join(workspace, 'src/dashboard-service.test.js'), `
import assert from 'node:assert/strict';
import test from 'node:test';
test('placeholder', () => assert.equal(1, 1));
`);

  const packet = await buildGreenfieldBuildPacket({
    workspacePath: workspace,
    planText: 'Continue the command center by adding workspace notification preferences and dashboard comparison overlays. Reuse Workspace, Dashboard, and Widget.',
    references: [],
  });

  assert.equal(packet.stage, 'continuation_iteration');
  assert.ok(packet.current_analysis);
  assert.equal(packet.architecture_memory.stage, 'cas_backed_continuation');
  assert.match(packet.product_focus.objective, /architecture map/);
  assert.ok(packet.product_focus.agent_should_not_spend_time_on.some((item: string) => item.includes('Re-discovering')));
  assert.ok(packet.product_focus.existing_behavior_to_extend.length > 0);
  assert.ok(packet.product_focus.existing_behavior_to_extend.some((item: any) => item.owner_files?.some((file: string) => file.includes('domain.ts') || file.includes('dashboard-service.ts'))));
  assert.equal(packet.growth_control_plane.mode, 'cas_backed_growth');
  assert.ok(packet.growth_control_plane.concept_ownership_contract.known_concepts.some((concept: string) => /Workspace|Dashboard|Widget/i.test(concept)));
  assert.ok(packet.growth_control_plane.concept_ownership_contract.owner_files.some((item: any) => item.file.includes('domain.ts') || item.file.includes('dashboard-service.ts')));
  assert.ok(packet.growth_control_plane.duplication_gate.required_before_new_model_or_service.some((item: string) => item.includes('known_concepts')));
  assert.equal(packet.growth_control_plane.context_budget.max_first_reads, 5);
  assert.match(packet.growth_control_plane.context_budget.read_rule, /Read only owner_files first/);
  assert.ok(packet.current_analysis!.graph.files >= 3);
  assert.ok(packet.architecture_memory.model_ownership.some((item: any) => /Workspace|Dashboard|Widget/i.test(item.concept)));
  assert.ok(packet.architecture_memory.boundary_ownership.some((item: any) => item.boundary.includes('dashboard-service.ts')));
  assert.ok(packet.architecture_memory.test_memory.some((item: any) => item.file.includes('dashboard-service.test.js')));
  assert.ok(packet.duplicate_prevention.known_concepts_already_defined.some(concept => /Workspace|Dashboard|Widget/i.test(concept)));
  assert.ok(packet.duplicate_prevention.likely_reused_concepts_for_this_slice.some(concept => /Workspace|Dashboard|Widget/i.test(concept)));
  assert.ok(packet.context_budget.read_first.some((item: any) => item.file.includes('domain.ts')));
  assert.ok(packet.validation_plan.klauro_checks.includes('analyze_codebase with incremental state'));
});

test('greenfield build packet prioritizes domain folders as first-read memory', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-domain-folder-greenfield-'));
  await fs.outputJson(path.join(workspace, 'package.json'), { type: 'module' });
  await fs.outputFile(path.join(workspace, 'src/domain/concepts.js'), `
export class Workspace { constructor({ id }) { this.id = id; } }
export class SignalRule { constructor({ id, workspaceId }) { this.id = id; this.workspaceId = workspaceId; } }
`);
  await fs.outputFile(path.join(workspace, 'src/services/rule-service.js'), `
import { SignalRule } from '../domain/concepts.js';
export class RuleService { create(input) { return new SignalRule(input); } }
`);

  const packet = await buildGreenfieldBuildPacket({
    workspacePath: workspace,
    planText: 'Continue by adding signal rule comparison overlays and reuse Workspace and SignalRule.',
    references: [],
  });

  assert.ok(packet.context_budget.read_first.some((item: any) => item.file === 'src/domain/concepts.js'));
  assert.ok(packet.context_budget.read_first.some((item: any) => item.file === 'src/services/rule-service.js'));
  assert.ok(packet.architecture_memory.boundary_ownership.some((item: any) => item.boundary === 'src/services/rule-service.js'));
  assert.ok(packet.duplicate_prevention.likely_reused_concepts_for_this_slice.includes('Workspace'));
  assert.ok(packet.duplicate_prevention.likely_reused_concepts_for_this_slice.includes('SignalRule'));
});

test('greenfield build packet gives positive owner guidance for adjacent new behavior', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-adjacent-greenfield-'));
  await fs.outputJson(path.join(workspace, 'package.json'), { type: 'module' });
  await fs.outputFile(path.join(workspace, 'src/domain/concepts.ts'), `
export interface Workspace { id: string; name: string; }
export interface SignalRule { id: string; workspaceId: string; expression: string; }
export interface SignalDigest { id: string; workspaceId: string; sentAt: string; }
`);
  await fs.outputFile(path.join(workspace, 'src/services/signal-operations.service.ts'), `
import type { SignalDigest, SignalRule, Workspace } from '../domain/concepts';
export class SignalOperationsService {
  evaluate(workspace: Workspace, rules: SignalRule[]) { return rules.filter(rule => rule.workspaceId === workspace.id); }
  dailyDigest(workspace: Workspace): SignalDigest { return { id: workspace.id, workspaceId: workspace.id, sentAt: new Date().toISOString() }; }
}
`);
  await fs.outputFile(path.join(workspace, 'src/services/signal-operations.service.test.ts'), `
import assert from 'node:assert/strict';
import test from 'node:test';
test('placeholder', () => assert.equal(1, 1));
`);

  const packet = await buildGreenfieldBuildPacket({
    workspacePath: workspace,
    planText: 'Continue with escalation windows, audit exports, workspace risk rollups, and digest subscriptions.',
    references: [],
  });

  const extensionTargets = packet.product_focus.existing_behavior_to_extend;
  assert.ok(extensionTargets.length > 0);
  assert.ok(extensionTargets.some((item: any) => item.owner_files?.includes('src/services/signal-operations.service.ts')));
  assert.ok(extensionTargets.some((item: any) => item.entities?.some((entity: string) => /Workspace|SignalDigest/i.test(entity))));
  assert.ok(extensionTargets.every((item: any) => item.agent_guidance));
});

test('greenfield build packet ignores agent worktrees and fixtures for owner-file memory', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-build-memory-filter-'));
  await fs.outputJson(path.join(workspace, 'package.json'), { type: 'module' });
  await fs.outputFile(path.join(workspace, 'src/domain/evidence.ts'), `
export interface EvidenceRequest { id: string; controlId: string; reviewerId: string; }
export interface ControlRenewalWindow { id: string; controlId: string; startsAt: string; }
`);
  await fs.outputFile(path.join(workspace, 'src/services/evidence-review.service.ts'), `
import type { EvidenceRequest } from '../domain/evidence';
export class EvidenceReviewService {
  assign(request: EvidenceRequest, reviewerId: string) { return { ...request, reviewerId }; }
}
`);
  await fs.outputFile(path.join(workspace, '.claude/worktrees/stale/src/database/entities/component.entity.ts'), `
export class ComponentEntity { id!: string; }
`);
  await fs.outputFile(path.join(workspace, 'apps/mcp-server/fixtures/idioms/rust-service/src/main.rs'), `
struct FixtureService;
`);

  const packet = await buildGreenfieldBuildPacket({
    workspacePath: workspace,
    planText: 'Continue the evidence platform by adding control renewal windows, audit exports, and reviewer queues. Reuse EvidenceRequest.',
    references: [],
  });

  const readFirst = packet.context_budget.read_first.map((item: any) => item.file);
  const ownerFiles = packet.product_focus.existing_behavior_to_extend.flatMap((item: any) => item.owner_files || []);
  assert.ok(readFirst.some((file: string) => file === 'src/domain/evidence.ts'));
  assert.ok(readFirst.some((file: string) => file === 'src/services/evidence-review.service.ts'));
  assert.ok([...readFirst, ...ownerFiles].every((file: string) => !file.includes('.claude/worktrees')));
  assert.ok([...readFirst, ...ownerFiles].every((file: string) => !file.includes('/fixtures/')));
});

test('greenfield build packet ranks owner-file memory by requested plan terms', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'klauro-build-memory-relevance-'));
  await fs.outputJson(path.join(workspace, 'package.json'), { type: 'module' });
  await fs.outputFile(path.join(workspace, 'packages/analyzer-core/src/database/entities/component.entity.ts'), `
export class ComponentEntity { id!: string; }
`);
  await fs.outputFile(path.join(workspace, 'apps/mcp-server/src/greenfield-build-session.ts'), `
export function buildGreenfieldBuildPacket() { return 'greenfield continuation packet'; }
`);
  await fs.outputFile(path.join(workspace, 'apps/mcp-server/src/agent-scratch-build-benchmark.ts'), `
export function runScratchComplianceBenchmark() { return 'compliance multi-wave proof'; }
`);
  await fs.outputFile(path.join(workspace, 'docs/mcp/AGENT-PERFORMANCE-PROOF.md'), `
# Agent Performance Proof
Compliance multi-wave evidence belongs here.
`);

  const packet = await buildGreenfieldBuildPacket({
    workspacePath: workspace,
    planText: 'Improve greenfield continuation packets and update compliance multi-wave proof docs.',
    references: [],
  });

  const readFirst = packet.context_budget.read_first.map((item: any) => item.file);
  assert.ok(readFirst.some((file: string) => file.includes('greenfield-build-session.ts') || file.includes('agent-scratch-build-benchmark.ts')));
  assert.ok(!readFirst.includes('packages/analyzer-core/src/database/entities/component.entity.ts'));
});
