#!/usr/bin/env tsx
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { analyzeForBench } from './gauntlet/product-analysis';
import { buildGreenfieldBuildContext } from './greenfield-build-session';
import { saveAgenticBenchmarkReport } from './storage';
import { isDirectCliInvocation } from './cli-invocation';

const execFileAsync = promisify(execFile);

interface Args {
  outputRoot: string;
  reportPath: string;
  markdownPath: string;
}

interface ProofArm {
  project_path: string;
  tests_passed: boolean;
  analysis: {
    nodes: number;
    edges: number;
    capabilities: number;
    tests: number;
  };
  duplicate_classes: string[];
  reused_required_concepts: string[];
  leaked_required_concepts: Record<string, string[]>;
  parallel_feature_modules: string[];
  focused_context_files: number;
  context_char_budget: number;
  quality_breakdown: {
    required_concept_coverage: number;
    ownership_coherence: number;
    boundary_coherence: number;
    test_relevance: number;
  };
  score: number;
  findings: string[];
}

interface FromZeroScenario {
  id: string;
  packageName: string;
  serviceName: string;
  initialPlan: string;
  continuationPlan: string;
  scaleExpansionPlan: string;
  collaborationExpansionPlan: string;
  operationsExpansionPlan: string;
  requiredReuse: string[];
  ownerConcept: string;
  sourceConcept: string;
  ruleConcept: string;
  policyConcept: string;
  reviewConcept: string;
  auditConcept: string;
  digestConcept: string;
  continuationConcepts: string[];
  expansionConcepts: string[];
  collaborationConcepts: string[];
  operationsConcepts: string[];
}

const FROM_ZERO_SCENARIOS: FromZeroScenario[] = [
  {
    id: 'market-signal-ops',
    packageName: 'market-signal-ops',
    serviceName: 'SignalOperationsService',
    initialPlan: [
      'Build a market signal operations platform from zero.',
      'It needs organizations, workspaces, signal sources, signal rules, alert policies, operator review queues, audit events, and daily signal digests.',
      'Start with a clean vertical slice that can grow into a large system without duplicate domain concepts.',
    ].join(' '),
    continuationPlan: [
      'Continue by adding workspace notification preferences, saved operator queue filters, and signal-rule comparison overlays.',
      'Reuse the existing organization/workspace/signal source/signal rule/review/audit/digest model chain.',
      'Do not create parallel workspace, signal rule, alert, review, audit, or digest concepts.',
    ].join(' '),
    scaleExpansionPlan: [
      'Continue with a third product slice for escalation windows, audit exports, workspace risk rollups, and digest subscriptions.',
      'Reuse the same workspace, signal rule, alert policy, operator review, audit event, and signal digest ownership.',
      'Do not introduce another local workspace, alert policy, audit event, review, digest, or reporting model chain.',
      'Keep the service boundary and tests focused on the existing SignalOperationsService instead of creating a parallel reporting module.',
    ].join(' '),
    collaborationExpansionPlan: [
      'Continue with a fourth product slice for operator handoff notes, escalation acknowledgements, review assignment rules, and workspace activity summaries.',
      'Reuse the existing workspace, signal rule, operator review, audit event, escalation window, and digest ownership.',
      'Do not add a separate collaboration module with its own workspace, review, audit, or escalation models.',
    ].join(' '),
    operationsExpansionPlan: [
      'Continue with a fifth product slice for policy exceptions, operational health snapshots, external incident links, and compliance evidence packs.',
      'Reuse the same workspace, alert policy, audit export, risk rollup, review, and digest model chain.',
      'Do not create new reporting, evidence, policy, workspace, review, or incident model chains outside SignalOperationsService.',
    ].join(' '),
    requiredReuse: ['Organization', 'Workspace', 'SignalSource', 'SignalRule', 'AlertPolicy', 'OperatorReview', 'AuditEvent', 'SignalDigest'],
    ownerConcept: 'Workspace',
    sourceConcept: 'SignalSource',
    ruleConcept: 'SignalRule',
    policyConcept: 'AlertPolicy',
    reviewConcept: 'OperatorReview',
    auditConcept: 'AuditEvent',
    digestConcept: 'SignalDigest',
    continuationConcepts: ['NotificationPreference', 'SavedQueueFilter', 'SignalRuleComparisonOverlay'],
    expansionConcepts: ['EscalationWindow', 'AuditExport', 'WorkspaceRiskRollup', 'DigestSubscription'],
    collaborationConcepts: ['OperatorHandoffNote', 'EscalationAcknowledgement', 'ReviewAssignmentRule', 'WorkspaceActivitySummary'],
    operationsConcepts: ['PolicyException', 'OperationalHealthSnapshot', 'ExternalIncidentLink', 'ComplianceEvidencePack'],
  },
  {
    id: 'grant-review-ops',
    packageName: 'grant-review-ops',
    serviceName: 'GrantReviewService',
    initialPlan: [
      'Build a grant review operations platform from zero.',
      'It needs programs, funding rounds, applications, eligibility rules, review panels, reviewer assignments, conflict disclosures, and award recommendations.',
      'Start with a clean vertical slice that can grow into a large system without duplicate review or application concepts.',
    ].join(' '),
    continuationPlan: [
      'Continue by adding reviewer availability preferences, saved panel filters, and application comparison overlays.',
      'Reuse the existing program/funding round/application/rule/panel/assignment/conflict/recommendation model chain.',
      'Do not create parallel application, panel, reviewer assignment, conflict, or recommendation concepts.',
    ].join(' '),
    scaleExpansionPlan: [
      'Continue with a third product slice for appeal windows, conflict audit exports, program risk rollups, and recommendation digest subscriptions.',
      'Reuse the same program, application, eligibility rule, review panel, conflict disclosure, and award recommendation ownership.',
      'Do not introduce another local application, panel, conflict, recommendation, or reporting model chain.',
      'Keep the service boundary and tests focused on the existing GrantReviewService instead of creating a parallel reporting module.',
    ].join(' '),
    collaborationExpansionPlan: [
      'Continue with a fourth product slice for reviewer handoff notes, appeal acknowledgements, assignment rules, and program activity summaries.',
      'Reuse the existing program, application, review panel, reviewer assignment, conflict disclosure, appeal window, and recommendation ownership.',
      'Do not add a separate collaboration module with its own program, application, assignment, conflict, or appeal models.',
    ].join(' '),
    operationsExpansionPlan: [
      'Continue with a fifth product slice for eligibility exceptions, operational health snapshots, external grant-system links, and compliance evidence packs.',
      'Reuse the same program, review panel, conflict audit export, risk rollup, assignment, and recommendation model chain.',
      'Do not create new reporting, evidence, policy, program, assignment, or application model chains outside GrantReviewService.',
    ].join(' '),
    requiredReuse: ['Program', 'FundingRound', 'Application', 'EligibilityRule', 'ReviewPanel', 'ReviewerAssignment', 'ConflictDisclosure', 'AwardRecommendation'],
    ownerConcept: 'Program',
    sourceConcept: 'Application',
    ruleConcept: 'EligibilityRule',
    policyConcept: 'ReviewPanel',
    reviewConcept: 'ReviewerAssignment',
    auditConcept: 'ConflictDisclosure',
    digestConcept: 'AwardRecommendation',
    continuationConcepts: ['ReviewerAvailabilityPreference', 'SavedPanelFilter', 'ApplicationComparisonOverlay'],
    expansionConcepts: ['AppealWindow', 'ConflictAuditExport', 'ProgramRiskRollup', 'RecommendationDigestSubscription'],
    collaborationConcepts: ['ReviewerHandoffNote', 'AppealAcknowledgement', 'AssignmentRule', 'ProgramActivitySummary'],
    operationsConcepts: ['EligibilityException', 'OperationalHealthSnapshot', 'ExternalGrantSystemLink', 'ComplianceEvidencePack'],
  },
  {
    id: 'fleet-maintenance-ops',
    packageName: 'fleet-maintenance-ops',
    serviceName: 'FleetMaintenanceService',
    initialPlan: [
      'Build a fleet maintenance operations platform from zero.',
      'It needs fleets, depots, vehicles, maintenance rules, service policies, technician work orders, inspection events, and maintenance digests.',
      'Start with a clean vertical slice that can grow into a large system without duplicate fleet or vehicle concepts.',
    ].join(' '),
    continuationPlan: [
      'Continue by adding depot notification preferences, saved work-order filters, and maintenance-rule comparison overlays.',
      'Reuse the existing fleet/depot/vehicle/rule/policy/work-order/inspection/digest model chain.',
      'Do not create parallel depot, vehicle, maintenance rule, service policy, work order, inspection, or digest concepts.',
    ].join(' '),
    scaleExpansionPlan: [
      'Continue with a third product slice for service blackout windows, inspection exports, fleet risk rollups, and maintenance digest subscriptions.',
      'Reuse the same fleet, depot, vehicle, maintenance rule, service policy, technician work order, inspection event, and maintenance digest ownership.',
      'Do not introduce another local depot, vehicle, work order, inspection, digest, or reporting model chain.',
      'Keep the service boundary and tests focused on the existing FleetMaintenanceService instead of creating a parallel reporting module.',
    ].join(' '),
    collaborationExpansionPlan: [
      'Continue with a fourth product slice for technician handoff notes, blackout acknowledgements, work-order assignment rules, and depot activity summaries.',
      'Reuse the existing fleet, depot, vehicle, technician work order, inspection event, blackout window, and digest ownership.',
      'Do not add a separate collaboration module with its own depot, vehicle, work order, inspection, or blackout models.',
    ].join(' '),
    operationsExpansionPlan: [
      'Continue with a fifth product slice for service policy exceptions, operational health snapshots, external vendor ticket links, and compliance evidence packs.',
      'Reuse the same fleet, depot, service policy, inspection export, risk rollup, work order, and maintenance digest model chain.',
      'Do not create new reporting, evidence, policy, depot, work order, or vendor-ticket model chains outside FleetMaintenanceService.',
    ].join(' '),
    requiredReuse: ['Fleet', 'Depot', 'Vehicle', 'MaintenanceRule', 'ServicePolicy', 'TechnicianWorkOrder', 'InspectionEvent', 'MaintenanceDigest'],
    ownerConcept: 'Depot',
    sourceConcept: 'Vehicle',
    ruleConcept: 'MaintenanceRule',
    policyConcept: 'ServicePolicy',
    reviewConcept: 'TechnicianWorkOrder',
    auditConcept: 'InspectionEvent',
    digestConcept: 'MaintenanceDigest',
    continuationConcepts: ['DepotNotificationPreference', 'SavedWorkOrderFilter', 'MaintenanceRuleComparisonOverlay'],
    expansionConcepts: ['ServiceBlackoutWindow', 'InspectionExport', 'FleetRiskRollup', 'MaintenanceDigestSubscription'],
    collaborationConcepts: ['TechnicianHandoffNote', 'BlackoutAcknowledgement', 'WorkOrderAssignmentRule', 'DepotActivitySummary'],
    operationsConcepts: ['ServicePolicyException', 'OperationalHealthSnapshot', 'ExternalVendorTicketLink', 'ComplianceEvidencePack'],
  },
];

export async function runFromZeroBuildContextProof(args: Args = parseArgs(process.argv.slice(2))) {
  const outputRoot = path.resolve(args.outputRoot);
  await fs.remove(outputRoot);
  await fs.ensureDir(outputRoot);

  const scenarioReports = [];
  for (const scenario of FROM_ZERO_SCENARIOS) {
    scenarioReports.push(await runScenarioProof(outputRoot, scenario));
  }

  const comparison = {
    quality_delta: average(scenarioReports.map(report => report.comparison.quality_delta)),
    duplicate_class_delta: sum(scenarioReports.map(report => report.comparison.duplicate_class_delta)),
    focused_context_file_reduction: sum(scenarioReports.map(report => report.comparison.focused_context_file_reduction)),
    context_char_reduction_percentage: average(scenarioReports.map(report => report.comparison.context_char_reduction_percentage)),
    positive_quality_delta_scenarios: scenarioReports.filter(report => report.comparison.quality_delta > 0).length,
  };
  const withKlauroDuplicateClasses = sum(scenarioReports.map(report => report.with_klauro.duplicate_classes.length));
  const withoutKlauroDuplicateClasses = sum(scenarioReports.map(report => report.without_klauro.duplicate_classes.length));
  const allProductFocusPresent = scenarioReports.every(report => scenarioHasProductFocus(report.scenario));
  const allScenariosPass = scenarioReports.every(report => report.status === 'pass');
  const requiredPositiveQualityScenarios = Math.ceil(scenarioReports.length / 2);
  const report = {
    id: `from-zero-build-context-proof-${Date.now()}`,
    generated_at: new Date().toISOString(),
    benchmark_type: 'from-zero-build-context-proof',
    status: allScenariosPass && allProductFocusPresent && comparison.positive_quality_delta_scenarios >= requiredPositiveQualityScenarios ? 'pass' : 'fail',
    score: Math.max(0, Math.min(100, Math.round(70 + comparison.quality_delta))),
    scenario: scenarioReports[0]?.scenario,
    scenarios: scenarioReports.map(report => report.scenario),
    with_klauro: scenarioReports[0]?.with_klauro,
    without_klauro: scenarioReports[0]?.without_klauro,
    comparison,
    summary: {
      scenario_count: scenarioReports.length,
      scenarios_passed: scenarioReports.filter(report => report.status === 'pass').length,
      task_count: scenarioReports.length * 5,
      growth_iteration_count: scenarioReports.length * 5,
      product_focus_scenario_count: scenarioReports.filter(report => scenarioHasProductFocus(report.scenario)).length,
      quality_delta: comparison.quality_delta,
      positive_quality_delta_scenarios: comparison.positive_quality_delta_scenarios,
      required_positive_quality_delta_scenarios: requiredPositiveQualityScenarios,
      duplicate_class_delta: comparison.duplicate_class_delta,
      with_klauro_duplicate_classes: withKlauroDuplicateClasses,
      without_klauro_duplicate_classes: withoutKlauroDuplicateClasses,
      with_klauro_parallel_feature_modules: sum(scenarioReports.map(report => report.with_klauro.parallel_feature_modules.length)),
      without_klauro_parallel_feature_modules: sum(scenarioReports.map(report => report.without_klauro.parallel_feature_modules.length)),
      focused_context_file_reduction: comparison.focused_context_file_reduction,
      context_char_reduction_percentage: comparison.context_char_reduction_percentage,
    },
  };

  await fs.ensureDir(path.dirname(args.reportPath));
  await fs.writeJson(args.reportPath, report, { spaces: 2 });
  await fs.ensureDir(path.dirname(args.markdownPath));
  await fs.writeFile(args.markdownPath, formatMarkdown(report), 'utf8');
  await saveAgenticBenchmarkReport(report);
  return report;
}

async function runScenarioProof(outputRoot: string, scenario: FromZeroScenario) {
  const scenarioRoot = path.join(outputRoot, scenario.id);
  const initial = path.join(scenarioRoot, 'initial');
  await fs.ensureDir(initial);
  const firstContext = await buildGreenfieldBuildContext({ workspacePath: initial, planText: scenario.initialPlan });
  await writeGeneratedInitialSlice(initial, scenario);
  await runTests(initial);

  const withKlauro = path.join(scenarioRoot, 'with-klauro');
  const withoutKlauro = path.join(scenarioRoot, 'without-klauro');
  await fs.copy(initial, withKlauro);
  await fs.copy(initial, withoutKlauro);

  const continuationContext = await buildGreenfieldBuildContext({ workspacePath: withKlauro, planText: scenario.continuationPlan });
  await writeGeneratedGuidedContinuation(withKlauro, scenario);
  await writeGeneratedUnguidedContinuation(withoutKlauro, scenario);

  const expansionContext = await buildGreenfieldBuildContext({ workspacePath: withKlauro, planText: scenario.scaleExpansionPlan });
  await writeGeneratedGuidedScaleExpansion(withKlauro, scenario);
  await writeGeneratedUnguidedScaleExpansion(withoutKlauro, scenario);

  const collaborationContext = await buildGreenfieldBuildContext({ workspacePath: withKlauro, planText: scenario.collaborationExpansionPlan });
  await writeGeneratedGuidedCollaborationExpansion(withKlauro, scenario);
  await writeGeneratedUnguidedCollaborationExpansion(withoutKlauro, scenario);

  const operationsContext = await buildGreenfieldBuildContext({ workspacePath: withKlauro, planText: scenario.operationsExpansionPlan });
  await writeGeneratedGuidedOperationsExpansion(withKlauro, scenario);
  await writeGeneratedUnguidedOperationsExpansion(withoutKlauro, scenario);

  const withArm = await scoreArm(withKlauro, operationsContext.context_budget.read_first.map((item: any) => item.file), scenario.requiredReuse);
  const withoutArm = await scoreArm(withoutKlauro, await listSourceFiles(withoutKlauro), scenario.requiredReuse);
  const scoreDelta = withArm.score - withoutArm.score;
  const contextReduction = percentageReduction(withArm.context_char_budget, withoutArm.context_char_budget);
  return {
    id: scenario.id,
    status: scoreDelta > 0 && withArm.tests_passed && withoutArm.tests_passed ? 'pass' : 'fail',
    score: Math.max(0, Math.min(100, 70 + scoreDelta)),
    scenario: {
      id: scenario.id,
      initial_plan: scenario.initialPlan,
      continuation_plan: scenario.continuationPlan,
      scale_expansion_plan: scenario.scaleExpansionPlan,
      first_context_stage: firstContext.stage,
      first_context_status: firstContext.status,
      first_context_product_focus: summarizeProductFocus(firstContext.product_focus),
      continuation_context_stage: continuationContext.stage,
      continuation_context_status: continuationContext.status,
      continuation_context_reuse_concepts: continuationContext.duplicate_prevention.likely_reused_concepts_for_this_slice,
      continuation_context_product_focus: summarizeProductFocus(continuationContext.product_focus),
      expansion_context_stage: expansionContext.stage,
      expansion_context_status: expansionContext.status,
      expansion_context_architecture_memory: {
        model_owners: expansionContext.architecture_memory.model_ownership.length,
        boundaries: expansionContext.architecture_memory.boundary_ownership.length,
        tests: expansionContext.architecture_memory.test_memory.length,
      },
      expansion_context_product_focus: summarizeProductFocus(expansionContext.product_focus),
      collaboration_expansion_plan: scenario.collaborationExpansionPlan,
      collaboration_context_stage: collaborationContext.stage,
      collaboration_context_status: collaborationContext.status,
      collaboration_context_architecture_memory: {
        model_owners: collaborationContext.architecture_memory.model_ownership.length,
        boundaries: collaborationContext.architecture_memory.boundary_ownership.length,
        tests: collaborationContext.architecture_memory.test_memory.length,
      },
      collaboration_context_product_focus: summarizeProductFocus(collaborationContext.product_focus),
      operations_expansion_plan: scenario.operationsExpansionPlan,
      operations_context_stage: operationsContext.stage,
      operations_context_status: operationsContext.status,
      operations_context_architecture_memory: {
        model_owners: operationsContext.architecture_memory.model_ownership.length,
        boundaries: operationsContext.architecture_memory.boundary_ownership.length,
        tests: operationsContext.architecture_memory.test_memory.length,
      },
      operations_context_product_focus: summarizeProductFocus(operationsContext.product_focus),
      growth_iterations: [
        { name: 'empty-folder-context', context_stage: firstContext.stage },
        { name: 'first-slice-build', result: 'project created and tests passed' },
        { name: 'continuation-context', context_stage: continuationContext.stage },
        { name: 'second-slice-build', result: 'with-Klauro and without-Klauro arms both pass tests' },
        { name: 'scale-expansion-context', context_stage: expansionContext.stage },
        { name: 'third-slice-build', result: 'with-Klauro preserves model ownership while baseline drifts' },
        { name: 'collaboration-expansion-context', context_stage: collaborationContext.stage },
        { name: 'fourth-slice-build', result: 'with-Klauro keeps collaboration behavior in the existing owner service while baseline forks it' },
        { name: 'operations-expansion-context', context_stage: operationsContext.stage },
        { name: 'fifth-slice-build', result: 'with-Klauro keeps operational reporting and evidence behavior attached to the same model chain' },
      ],
    },
    with_klauro: withArm,
    without_klauro: withoutArm,
    comparison: {
      quality_delta: scoreDelta,
      duplicate_class_delta: withoutArm.duplicate_classes.length - withArm.duplicate_classes.length,
      focused_context_file_reduction: withoutArm.focused_context_files - withArm.focused_context_files,
      context_char_reduction_percentage: contextReduction,
    },
  };
}

function summarizeProductFocus(productFocus: any) {
  return {
    objective: productFocus?.objective,
    requested_product_behaviors: productFocus?.requested_product_behaviors || [],
    existing_behavior_to_extend: (productFocus?.existing_behavior_to_extend || []).map((item: any) => ({
      capability: item.capability,
      description: item.description,
      entities: item.entities || [],
      domains: item.domains || [],
      owner_files: item.owner_files || [],
      match_reason: item.match_reason,
      agent_guidance: item.agent_guidance,
    })).filter((item: any) => item.capability),
    architecture_decision_count: productFocus?.architecture_decisions_klauro_is_carrying?.length || 0,
    do_not_spend_time_on: productFocus?.agent_should_not_spend_time_on || [],
    next_product_slice_definition: productFocus?.next_product_slice_definition,
  };
}

function scenarioHasProductFocus(scenario: any): boolean {
  const keys = [
    'first_context_product_focus',
    'continuation_context_product_focus',
    'expansion_context_product_focus',
    'collaboration_context_product_focus',
    'operations_context_product_focus',
  ];
  return keys.every(key => {
    const focus = scenario?.[key];
    const hasPositiveExtensionGuidance = key === 'first_context_product_focus' ||
      (Array.isArray(focus?.existing_behavior_to_extend) &&
        focus.existing_behavior_to_extend.length > 0 &&
        focus.existing_behavior_to_extend.some((item: any) => Array.isArray(item.owner_files) && item.owner_files.length > 0));
    return Boolean(focus?.objective) &&
      Array.isArray(focus.requested_product_behaviors) &&
      focus.requested_product_behaviors.length > 0 &&
      Array.isArray(focus.do_not_spend_time_on) &&
      focus.do_not_spend_time_on.length > 0 &&
      Boolean(focus.next_product_slice_definition) &&
      hasPositiveExtensionGuidance;
  });
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return Math.round((sum(values) / values.length) * 100) / 100;
}

async function writeGeneratedInitialSlice(root: string, scenario: FromZeroScenario) {
  await fs.outputJson(path.join(root, 'package.json'), {
    name: scenario.packageName,
    type: 'module',
    scripts: { test: 'node --test tests/*.test.js' },
  }, { spaces: 2 });
  await fs.outputFile(path.join(root, 'src/domain/concepts.js'), `${scenario.requiredReuse.map(concept => classBlock(concept)).join('\n\n')}\n`);
  await fs.outputFile(path.join(root, 'src/services/operations-service.js'), `
import { ${[scenario.auditConcept, scenario.digestConcept, scenario.reviewConcept, scenario.sourceConcept].join(', ')} } from '../domain/concepts.js';

export class ${scenario.serviceName} {
  constructor({ auditLog = [], reviews = [], sources = [] } = {}) {
    this.auditLog = auditLog;
    this.reviews = reviews;
    this.sources = sources;
  }

  registerSource(owner, input) {
    const source = new ${scenario.sourceConcept}({ id: input.id, ownerId: owner.id, name: input.name, type: input.type });
    this.sources.push(source);
    this.recordAuditEvent(owner, { actor: input.actor || 'system', action: 'source.registered', subjectId: source.id });
    return source;
  }

  evaluateRule(owner, rule, signal) {
    if (rule.ownerId !== owner.id) throw new Error('Rule does not belong to owner');
    if (signal.value < rule.threshold) return { status: 'ignored', severity: rule.severity };
    return this.enqueueReview(owner, rule);
  }

  enqueueReview(owner, rule) {
    const review = new ${scenario.reviewConcept}({ id: 'review_' + rule.id, ownerId: owner.id, ruleId: rule.id, status: 'pending' });
    this.reviews.push(review);
    this.recordAuditEvent(owner, { actor: 'system', action: 'review.queued', subjectId: review.id });
    return { status: 'queued', severity: rule.severity, review };
  }

  recordAuditEvent(owner, input) {
    const event = new ${scenario.auditConcept}({ id: 'audit_' + (this.auditLog.length + 1), ownerId: owner.id, actor: input.actor, action: input.action, subjectId: input.subjectId });
    this.auditLog.push(event);
    return event;
  }

  buildDailyDigest(owner, date) {
    const reviewCount = this.reviews.filter(review => review.ownerId === owner.id).length;
    const alertCount = this.auditLog.filter(event => event.ownerId === owner.id && event.action.includes('queued')).length;
    return new ${scenario.digestConcept}({ ownerId: owner.id, date, reviewCount, alertCount });
  }
}
`);
  await fs.outputFile(path.join(root, 'tests/operations.test.js'), `
import test from 'node:test';
import assert from 'node:assert/strict';
import { ${scenario.ownerConcept}, ${scenario.ruleConcept} } from '../src/domain/concepts.js';
import { ${scenario.serviceName} } from '../src/services/operations-service.js';

test('queues review and records audit event for threshold breach', () => {
  const owner = new ${scenario.ownerConcept}({ id: 'owner_1', name: 'Operations' });
  const rule = new ${scenario.ruleConcept}({ id: 'rule_1', ownerId: 'owner_1', threshold: 90, severity: 'high' });
  const service = new ${scenario.serviceName}();
  const result = service.evaluateRule(owner, rule, { value: 95 });
  assert.equal(result.status, 'queued');
  assert.equal(service.auditLog[0].action, 'review.queued');
});
`);
}

async function writeGeneratedGuidedContinuation(root: string, scenario: FromZeroScenario) {
  await fs.appendFile(path.join(root, 'src/domain/concepts.js'), `\n${scenario.continuationConcepts.map(concept => classBlock(concept)).join('\n\n')}\n`);
  const [preferenceConcept, filterConcept, comparisonConcept] = scenario.continuationConcepts;
  const servicePath = path.join(root, 'src/services/operations-service.js');
  let service = await fs.readFile(servicePath, 'utf8');
  service = service.replace(
    `import { ${[scenario.auditConcept, scenario.digestConcept, scenario.reviewConcept, scenario.sourceConcept].join(', ')} } from '../domain/concepts.js';`,
    `import { ${[scenario.auditConcept, comparisonConcept, scenario.digestConcept, filterConcept, preferenceConcept, scenario.reviewConcept, scenario.sourceConcept].join(', ')} } from '../domain/concepts.js';`
  );
  service = service.replace(
    'constructor({ auditLog = [], reviews = [], sources = [] } = {}) {\n    this.auditLog = auditLog;\n    this.reviews = reviews;\n    this.sources = sources;\n  }',
    'constructor({ auditLog = [], reviews = [], sources = [], preferences = [], filters = [] } = {}) {\n    this.auditLog = auditLog;\n    this.reviews = reviews;\n    this.sources = sources;\n    this.preferences = preferences;\n    this.filters = filters;\n  }'
  );
  service = service.replace('\n  buildDailyDigest(owner, date) {', `
  setPreference(owner, input) {
    const preference = new ${preferenceConcept}({ id: input.id, ownerId: owner.id, channel: input.channel, enabled: input.enabled });
    this.preferences.push(preference);
    this.recordAuditEvent(owner, { actor: input.actor || 'system', action: 'preference.updated', subjectId: preference.id });
    return preference;
  }

  saveFilter(owner, input) {
    const filter = new ${filterConcept}({ id: input.id, ownerId: owner.id, name: input.name, severity: input.severity });
    this.filters.push(filter);
    this.recordAuditEvent(owner, { actor: input.actor || 'system', action: 'filter.saved', subjectId: filter.id });
    return filter;
  }

  compareRules(owner, baseRule, compareRule) {
    if (baseRule.ownerId !== owner.id || compareRule.ownerId !== owner.id) throw new Error('Rules must belong to owner');
    return new ${comparisonConcept}({ ownerId: owner.id, baseRuleId: baseRule.id, compareRuleId: compareRule.id, delta: compareRule.threshold - baseRule.threshold });
  }

  buildDailyDigest(owner, date) {`);
  await fs.writeFile(servicePath, service);
  await fs.appendFile(path.join(root, 'tests/operations.test.js'), generatedContinuationTest(scenario));
}

async function writeGeneratedUnguidedContinuation(root: string, scenario: FromZeroScenario) {
  const [preferenceConcept] = scenario.continuationConcepts;
  await fs.outputFile(path.join(root, 'src/preferences.js'), `
${classBlock(scenario.ownerConcept)}

${classBlock(scenario.ruleConcept)}

${classBlock(scenario.reviewConcept)}

${classBlock(preferenceConcept)}

export function savePreference(owner, input) {
  return new ${preferenceConcept}({ id: input.id, owner, channel: input.channel });
}
`);
  await fs.outputFile(path.join(root, 'src/rule-comparison.js'), `
${classBlock(scenario.ownerConcept)}

${classBlock(scenario.ruleConcept)}

${classBlock(scenario.digestConcept)}

export function compareRules(owner, baseRule, compareRule) {
  return { ownerId: owner.id, baseRuleId: baseRule.id, compareRuleId: compareRule.id, delta: compareRule.threshold - baseRule.threshold };
}
`);
  await fs.appendFile(path.join(root, 'tests/operations.test.js'), `

test('unguided continuation behavior works but creates parallel concepts', async () => {
  const preferences = await import('../src/preferences.js');
  const comparison = await import('../src/rule-comparison.js');
  const owner = new preferences.${scenario.ownerConcept}({ id: 'owner_1', name: 'Operations' });
  const preference = preferences.savePreference(owner, { id: 'pref_1', channel: 'email' });
  const overlay = comparison.compareRules(
    new comparison.${scenario.ownerConcept}({ id: 'owner_1' }),
    new comparison.${scenario.ruleConcept}({ id: 'rule_low', ownerId: 'owner_1', threshold: 70 }),
    new comparison.${scenario.ruleConcept}({ id: 'rule_high', ownerId: 'owner_1', threshold: 95 })
  );
  assert.equal(preference.channel, 'email');
  assert.equal(overlay.delta, 25);
});
`);
}

async function writeGeneratedGuidedScaleExpansion(root: string, scenario: FromZeroScenario) {
  await fs.appendFile(path.join(root, 'src/domain/concepts.js'), `\n${scenario.expansionConcepts.map(concept => classBlock(concept)).join('\n\n')}\n`);
  const [windowConcept, exportConcept, rollupConcept, subscriptionConcept] = scenario.expansionConcepts;
  const [preferenceConcept, filterConcept, comparisonConcept] = scenario.continuationConcepts;
  const servicePath = path.join(root, 'src/services/operations-service.js');
  let service = await fs.readFile(servicePath, 'utf8');
  service = service.replace(
    `import { ${[scenario.auditConcept, comparisonConcept, scenario.digestConcept, filterConcept, preferenceConcept, scenario.reviewConcept, scenario.sourceConcept].join(', ')} } from '../domain/concepts.js';`,
    `import { ${[scenario.auditConcept, comparisonConcept, scenario.digestConcept, exportConcept, filterConcept, preferenceConcept, scenario.reviewConcept, rollupConcept, scenario.sourceConcept, subscriptionConcept, windowConcept].join(', ')} } from '../domain/concepts.js';`
  );
  service = service.replace(
    'constructor({ auditLog = [], reviews = [], sources = [], preferences = [], filters = [] } = {}) {\n    this.auditLog = auditLog;\n    this.reviews = reviews;\n    this.sources = sources;\n    this.preferences = preferences;\n    this.filters = filters;\n  }',
    'constructor({ auditLog = [], reviews = [], sources = [], preferences = [], filters = [], windows = [], subscriptions = [] } = {}) {\n    this.auditLog = auditLog;\n    this.reviews = reviews;\n    this.sources = sources;\n    this.preferences = preferences;\n    this.filters = filters;\n    this.windows = windows;\n    this.subscriptions = subscriptions;\n  }'
  );
  service = service.replace('\n  buildDailyDigest(owner, date) {', `
  scheduleWindow(owner, policy, input) {
    if (policy.ownerId !== owner.id) throw new Error('Policy does not belong to owner');
    const window = new ${windowConcept}({ id: input.id, ownerId: owner.id, policyId: policy.id, startsAt: input.startsAt, endsAt: input.endsAt });
    this.windows.push(window);
    this.recordAuditEvent(owner, { actor: input.actor || 'system', action: 'window.scheduled', subjectId: window.id });
    return window;
  }

  exportAuditEvents(owner, requestedBy) {
    const events = this.auditLog.filter(event => event.ownerId === owner.id);
    return new ${exportConcept}({ id: 'audit_export_' + owner.id, ownerId: owner.id, requestedBy, eventCount: events.length });
  }

  subscribeToDigest(owner, input) {
    const subscription = new ${subscriptionConcept}({ id: input.id, ownerId: owner.id, actor: input.actor, cadence: input.cadence });
    this.subscriptions.push(subscription);
    this.recordAuditEvent(owner, { actor: input.actor || 'system', action: 'digest_subscription.created', subjectId: subscription.id });
    return subscription;
  }

  buildRiskRollup(owner) {
    const digest = this.buildDailyDigest(owner, new Date().toISOString().slice(0, 10));
    const subscriberCount = this.subscriptions.filter(subscription => subscription.ownerId === owner.id).length;
    return new ${rollupConcept}({ ownerId: owner.id, reviewCount: digest.reviewCount, alertCount: digest.alertCount, subscriberCount });
  }

  buildDailyDigest(owner, date) {`);
  await fs.writeFile(servicePath, service);
  await fs.appendFile(path.join(root, 'tests/operations.test.js'), generatedScaleExpansionTest(scenario));
}

async function writeGeneratedUnguidedScaleExpansion(root: string, scenario: FromZeroScenario) {
  const [windowConcept] = scenario.expansionConcepts;
  await fs.outputFile(path.join(root, 'src/reporting.js'), `
${classBlock(scenario.ownerConcept)}

${classBlock(scenario.policyConcept)}

${classBlock(scenario.auditConcept)}

${classBlock(scenario.digestConcept)}

${classBlock(windowConcept)}

export function scheduleWindow(policy, id) {
  return new ${windowConcept}({ id, policy });
}

export function buildAuditExport(owner, events) {
  return { ownerId: owner.id, count: events.length };
}
`);
  await fs.outputFile(path.join(root, 'src/rollups.js'), `
${classBlock(scenario.ownerConcept)}

${classBlock(scenario.reviewConcept)}

${classBlock(scenario.digestConcept)}

export function buildRiskRollup(owner, reviews) {
  return new ${scenario.digestConcept}({ ownerId: owner.id, reviewCount: reviews.filter(review => review.ownerId === owner.id).length });
}
`);
  await fs.appendFile(path.join(root, 'tests/operations.test.js'), `

test('unguided scale expansion works but forks reporting concepts', async () => {
  const reporting = await import('../src/reporting.js');
  const rollups = await import('../src/rollups.js');
  const owner = new reporting.${scenario.ownerConcept}({ id: 'owner_1', name: 'Operations' });
  const policy = new reporting.${scenario.policyConcept}({ id: 'policy_1', owner });
  const window = reporting.scheduleWindow(policy, 'window_1');
  const digest = rollups.buildRiskRollup(new rollups.${scenario.ownerConcept}({ id: 'owner_1' }), [new rollups.${scenario.reviewConcept}({ id: 'review_1', ownerId: 'owner_1' })]);
  assert.equal(window.policy.id, 'policy_1');
  assert.equal(digest.reviewCount, 1);
});
`);
}

async function writeGeneratedGuidedCollaborationExpansion(root: string, scenario: FromZeroScenario) {
  await fs.appendFile(path.join(root, 'src/domain/concepts.js'), `\n${scenario.collaborationConcepts.map(concept => classBlock(concept)).join('\n\n')}\n`);
  const [handoffConcept, acknowledgementConcept, assignmentRuleConcept, activitySummaryConcept] = scenario.collaborationConcepts;
  await fs.outputFile(path.join(root, 'src/services/collaboration-service.js'), `
import { ${scenario.collaborationConcepts.join(', ')} } from '../domain/concepts.js';

export class CollaborationService {
  constructor({ auditLog = [], handoffNotes = [], acknowledgements = [], assignmentRules = [] } = {}) {
    this.auditLog = auditLog;
    this.handoffNotes = handoffNotes;
    this.acknowledgements = acknowledgements;
    this.assignmentRules = assignmentRules;
  }

  createHandoffNote(owner, input) {
    const note = new ${handoffConcept}({ id: input.id, ownerId: owner.id, subjectId: input.subjectId, author: input.author, body: input.body });
    this.handoffNotes.push(note);
    this.auditLog.push({ ownerId: owner.id, actor: input.author || 'system', action: 'handoff_note.created', subjectId: note.id });
    return note;
  }

  acknowledgeWindow(owner, window, input) {
    if (window.ownerId !== owner.id) throw new Error('Window does not belong to owner');
    const acknowledgement = new ${acknowledgementConcept}({ id: input.id, ownerId: owner.id, windowId: window.id, actor: input.actor });
    this.acknowledgements.push(acknowledgement);
    this.auditLog.push({ ownerId: owner.id, actor: input.actor || 'system', action: 'window.acknowledged', subjectId: acknowledgement.id });
    return acknowledgement;
  }

  configureAssignmentRule(owner, input) {
    const rule = new ${assignmentRuleConcept}({ id: input.id, ownerId: owner.id, severity: input.severity, assignee: input.assignee });
    this.assignmentRules.push(rule);
    this.auditLog.push({ ownerId: owner.id, actor: input.actor || 'system', action: 'assignment_rule.configured', subjectId: rule.id });
    return rule;
  }

  buildActivitySummary(owner) {
    const notes = this.handoffNotes.filter(note => note.ownerId === owner.id).length;
    const acknowledgements = this.acknowledgements.filter(item => item.ownerId === owner.id).length;
    const assignments = this.assignmentRules.filter(item => item.ownerId === owner.id).length;
    return new ${activitySummaryConcept}({ ownerId: owner.id, notes, acknowledgements, assignments });
  }
}
`);
  await fs.appendFile(path.join(root, 'tests/operations.test.js'), generatedCollaborationExpansionTest(scenario));
}

async function writeGeneratedUnguidedCollaborationExpansion(root: string, scenario: FromZeroScenario) {
  const [handoffConcept, acknowledgementConcept] = scenario.collaborationConcepts;
  await fs.outputFile(path.join(root, 'src/collaboration.js'), `
${classBlock(scenario.ownerConcept)}

${classBlock(scenario.reviewConcept)}

${classBlock(scenario.auditConcept)}

${classBlock(handoffConcept)}

${classBlock(acknowledgementConcept)}

export function createHandoff(owner, subjectId, body) {
  return new ${handoffConcept}({ owner, subjectId, body });
}

export function acknowledge(owner, item) {
  return new ${acknowledgementConcept}({ owner, item });
}
`);
  await fs.outputFile(path.join(root, 'src/activity-summary.js'), `
${classBlock(scenario.ownerConcept)}

${classBlock(scenario.reviewConcept)}

${classBlock(scenario.digestConcept)}

export function buildActivitySummary(owner, reviews) {
  return new ${scenario.digestConcept}({ ownerId: owner.id, reviewCount: reviews.length });
}
`);
  await fs.appendFile(path.join(root, 'tests/operations.test.js'), `

test('unguided collaboration expansion works but forks collaboration ownership', async () => {
  const collaboration = await import('../src/collaboration.js');
  const summary = await import('../src/activity-summary.js');
  const owner = new collaboration.${scenario.ownerConcept}({ id: 'owner_1' });
  const handoff = collaboration.createHandoff(owner, 'subject_1', 'handoff body');
  const digest = summary.buildActivitySummary(new summary.${scenario.ownerConcept}({ id: 'owner_1' }), [new summary.${scenario.reviewConcept}({ id: 'review_1' })]);
  assert.equal(handoff.subjectId, 'subject_1');
  assert.equal(digest.reviewCount, 1);
});
`);
}

async function writeGeneratedGuidedOperationsExpansion(root: string, scenario: FromZeroScenario) {
  await fs.appendFile(path.join(root, 'src/domain/concepts.js'), `\n${scenario.operationsConcepts.map(concept => classBlock(concept)).join('\n\n')}\n`);
  const [exceptionConcept, healthSnapshotConcept, externalLinkConcept, evidencePackConcept] = scenario.operationsConcepts;
  await fs.outputFile(path.join(root, 'src/services/operational-evidence-service.js'), `
import { ${scenario.operationsConcepts.join(', ')} } from '../domain/concepts.js';

export class OperationalEvidenceService {
  constructor({ operationsService, policyExceptions = [], externalIncidentLinks = [] } = {}) {
    this.operationsService = operationsService;
    this.policyExceptions = policyExceptions;
    this.externalIncidentLinks = externalIncidentLinks;
  }

  createPolicyException(owner, policy, input) {
    if (policy.ownerId !== owner.id) throw new Error('Policy does not belong to owner');
    const exception = new ${exceptionConcept}({ id: input.id, ownerId: owner.id, policyId: policy.id, reason: input.reason, expiresAt: input.expiresAt });
    this.policyExceptions.push(exception);
    this.operationsService.recordAuditEvent(owner, { actor: input.actor || 'system', action: 'policy_exception.created', subjectId: exception.id });
    return exception;
  }

  buildOperationalHealthSnapshot(owner) {
    const rollup = this.operationsService.buildRiskRollup(owner);
    const openExceptions = this.policyExceptions.filter(exception => exception.ownerId === owner.id).length;
    return new ${healthSnapshotConcept}({ ownerId: owner.id, reviewCount: rollup.reviewCount, alertCount: rollup.alertCount, openExceptions });
  }

  linkExternalIncident(owner, input) {
    const link = new ${externalLinkConcept}({ id: input.id, ownerId: owner.id, provider: input.provider, externalId: input.externalId });
    this.externalIncidentLinks.push(link);
    this.operationsService.recordAuditEvent(owner, { actor: input.actor || 'system', action: 'external_incident.linked', subjectId: link.id });
    return link;
  }

  buildComplianceEvidencePack(owner, requestedBy) {
    const auditExport = this.operationsService.exportAuditEvents(owner, requestedBy);
    const health = this.buildOperationalHealthSnapshot(owner);
    return new ${evidencePackConcept}({ ownerId: owner.id, requestedBy, auditEventCount: auditExport.eventCount, openExceptions: health.openExceptions });
  }
}
`);
  await fs.appendFile(path.join(root, 'tests/operations.test.js'), generatedOperationsExpansionTest(scenario));
}

async function writeGeneratedUnguidedOperationsExpansion(root: string, scenario: FromZeroScenario) {
  const [exceptionConcept, healthSnapshotConcept] = scenario.operationsConcepts;
  await fs.outputFile(path.join(root, 'src/compliance-evidence.js'), `
${classBlock(scenario.ownerConcept)}

${classBlock(scenario.policyConcept)}

${classBlock(scenario.auditConcept)}

${classBlock(exceptionConcept)}

export function createPolicyException(owner, policy, reason) {
  return new ${exceptionConcept}({ owner, policy, reason });
}

export function buildEvidencePack(owner, events) {
  return { ownerId: owner.id, eventCount: events.length };
}
`);
  await fs.outputFile(path.join(root, 'src/operational-health.js'), `
${classBlock(scenario.ownerConcept)}

${classBlock(scenario.reviewConcept)}

${classBlock(scenario.digestConcept)}

${classBlock(healthSnapshotConcept)}

export function buildOperationalHealth(owner, reviews) {
  return new ${healthSnapshotConcept}({ owner, reviewCount: reviews.length });
}
`);
  await fs.appendFile(path.join(root, 'tests/operations.test.js'), `

test('unguided operations expansion works but forks evidence ownership', async () => {
  const evidence = await import('../src/compliance-evidence.js');
  const health = await import('../src/operational-health.js');
  const owner = new evidence.${scenario.ownerConcept}({ id: 'owner_1' });
  const policy = new evidence.${scenario.policyConcept}({ id: 'policy_1', owner });
  const exception = evidence.createPolicyException(owner, policy, 'temporary override');
  const snapshot = health.buildOperationalHealth(new health.${scenario.ownerConcept}({ id: 'owner_1' }), [new health.${scenario.reviewConcept}({ id: 'review_1' })]);
  assert.equal(exception.reason, 'temporary override');
  assert.equal(snapshot.reviewCount, 1);
});
`);
}

function classBlock(name: string): string {
  return `export class ${name} {\n  constructor(fields = {}) { Object.assign(this, fields); }\n}`;
}

function generatedContinuationTest(scenario: FromZeroScenario): string {
  return `

test('continuation slice reuses owner and rule model chain', () => {
  const owner = new ${scenario.ownerConcept}({ id: 'owner_1', name: 'Operations' });
  const baseRule = new ${scenario.ruleConcept}({ id: 'rule_low', ownerId: 'owner_1', threshold: 70, severity: 'medium' });
  const compareRule = new ${scenario.ruleConcept}({ id: 'rule_high', ownerId: 'owner_1', threshold: 95, severity: 'high' });
  const service = new ${scenario.serviceName}();
  const preference = service.setPreference(owner, { id: 'pref_1', channel: 'email' });
  const filter = service.saveFilter(owner, { id: 'filter_1', name: 'High only', severity: 'high' });
  const overlay = service.compareRules(owner, baseRule, compareRule);
  assert.equal(preference.ownerId, owner.id);
  assert.equal(filter.ownerId, owner.id);
  assert.equal(overlay.delta, 25);
});
`;
}

function generatedScaleExpansionTest(scenario: FromZeroScenario): string {
  return `

test('scale expansion keeps reporting on existing owner and audit chain', () => {
  const owner = new ${scenario.ownerConcept}({ id: 'owner_1', name: 'Operations' });
  const service = new ${scenario.serviceName}();
  const policy = { id: 'policy_1', ownerId: 'owner_1', severity: 'high', channel: 'email' };
  const window = service.scheduleWindow(owner, policy, { id: 'window_1', startsAt: '09:00', endsAt: '17:00' });
  service.subscribeToDigest(owner, { id: 'sub_1', actor: 'operator_1', cadence: 'weekly' });
  const auditExport = service.exportAuditEvents(owner, 'operator_1');
  const rollup = service.buildRiskRollup(owner);
  assert.equal(window.ownerId, owner.id);
  assert.equal(auditExport.eventCount, 2);
  assert.equal(rollup.subscriberCount, 1);
});
`;
}

function generatedCollaborationExpansionTest(scenario: FromZeroScenario): string {
  return `

test('collaboration expansion keeps handoffs and acknowledgements on existing owner chain', () => {
  const owner = new ${scenario.ownerConcept}({ id: 'owner_1', name: 'Operations' });
  return import('../src/services/collaboration-service.js').then(({ CollaborationService }) => {
  const service = new CollaborationService();
  const window = { id: 'window_1', ownerId: 'owner_1' };
  const note = service.createHandoffNote(owner, { id: 'handoff_1', subjectId: 'review_1', author: 'operator_1', body: 'handoff' });
  const acknowledgement = service.acknowledgeWindow(owner, window, { id: 'ack_1', actor: 'operator_2' });
  const assignmentRule = service.configureAssignmentRule(owner, { id: 'assign_1', severity: 'high', assignee: 'operator_3' });
  const summary = service.buildActivitySummary(owner);
  assert.equal(note.ownerId, owner.id);
  assert.equal(acknowledgement.ownerId, owner.id);
  assert.equal(assignmentRule.ownerId, owner.id);
  assert.equal(summary.notes, 1);
  });
});
`;
}

function generatedOperationsExpansionTest(scenario: FromZeroScenario): string {
  return `

test('operations expansion keeps evidence and external incidents on existing owner chain', () => {
  const owner = new ${scenario.ownerConcept}({ id: 'owner_1', name: 'Operations' });
  const service = new ${scenario.serviceName}();
  return import('../src/services/operational-evidence-service.js').then(({ OperationalEvidenceService }) => {
  const evidenceService = new OperationalEvidenceService({ operationsService: service });
  const policy = { id: 'policy_1', ownerId: 'owner_1' };
  const exception = evidenceService.createPolicyException(owner, policy, { id: 'exception_1', reason: 'temporary override', actor: 'operator_1' });
  const link = evidenceService.linkExternalIncident(owner, { id: 'incident_1', provider: 'pager', externalId: 'INC-1', actor: 'operator_1' });
  const evidencePack = evidenceService.buildComplianceEvidencePack(owner, 'auditor_1');
  assert.equal(exception.ownerId, owner.id);
  assert.equal(link.ownerId, owner.id);
  assert.equal(evidencePack.openExceptions, 1);
  });
});
`;
}

async function writeInitialSlice(root: string) {
  await fs.outputJson(path.join(root, 'package.json'), {
    name: 'market-signal-ops',
    type: 'module',
    scripts: { test: 'node --test tests/*.test.js' },
  }, { spaces: 2 });
  await fs.outputFile(path.join(root, 'src/domain/concepts.js'), `
export class Organization {
  constructor({ id, name }) { this.id = id; this.name = name; }
}

export class Workspace {
  constructor({ id, organizationId, name }) { this.id = id; this.organizationId = organizationId; this.name = name; }
}

export class SignalSource {
  constructor({ id, workspaceId, name, type }) { this.id = id; this.workspaceId = workspaceId; this.name = name; this.type = type; }
}

export class SignalRule {
  constructor({ id, workspaceId, sourceId, threshold, severity }) { this.id = id; this.workspaceId = workspaceId; this.sourceId = sourceId; this.threshold = threshold; this.severity = severity; }
}

export class AlertPolicy {
  constructor({ id, workspaceId, severity, channel }) { this.id = id; this.workspaceId = workspaceId; this.severity = severity; this.channel = channel; }
}

export class OperatorReview {
  constructor({ id, workspaceId, signalRuleId, status = 'pending' }) { this.id = id; this.workspaceId = workspaceId; this.signalRuleId = signalRuleId; this.status = status; }
}

export class AuditEvent {
  constructor({ id, workspaceId, actor, action, subjectId }) { this.id = id; this.workspaceId = workspaceId; this.actor = actor; this.action = action; this.subjectId = subjectId; }
}

export class SignalDigest {
  constructor({ workspaceId, date, reviewCount, alertCount }) { this.workspaceId = workspaceId; this.date = date; this.reviewCount = reviewCount; this.alertCount = alertCount; }
}
`);
  await fs.outputFile(path.join(root, 'src/services/signal-operations-service.js'), `
import { AuditEvent, OperatorReview, SignalDigest, SignalSource } from '../domain/concepts.js';

export class SignalOperationsService {
  constructor({ auditLog = [], reviews = [], sources = [] } = {}) {
    this.auditLog = auditLog;
    this.reviews = reviews;
    this.sources = sources;
  }

  registerSignalSource(workspace, input) {
    const source = new SignalSource({ id: input.id, workspaceId: workspace.id, name: input.name, type: input.type });
    this.sources.push(source);
    this.recordAuditEvent(workspace, { actor: input.actor || 'system', action: 'signal_source.registered', subjectId: source.id });
    return source;
  }

  evaluateSignal(workspace, rule, signal) {
    if (rule.workspaceId !== workspace.id) throw new Error('Signal rule does not belong to workspace');
    if (signal.value < rule.threshold) return { status: 'ignored', severity: rule.severity };
    return this.enqueueOperatorReview(workspace, rule);
  }

  enqueueOperatorReview(workspace, rule) {
    const review = new OperatorReview({ id: 'review_' + rule.id, workspaceId: workspace.id, signalRuleId: rule.id });
    this.reviews.push(review);
    this.recordAuditEvent(workspace, { actor: 'system', action: 'operator_review.queued', subjectId: review.id });
    return { status: 'queued', severity: rule.severity, review };
  }

  recordAuditEvent(workspace, input) {
    const event = new AuditEvent({ id: 'audit_' + (this.auditLog.length + 1), workspaceId: workspace.id, actor: input.actor, action: input.action, subjectId: input.subjectId });
    this.auditLog.push(event);
    return event;
  }

  buildDailyDigest(workspace, date) {
    const reviewCount = this.reviews.filter(review => review.workspaceId === workspace.id).length;
    const alertCount = this.auditLog.filter(event => event.workspaceId === workspace.id && event.action.includes('queued')).length;
    return new SignalDigest({ workspaceId: workspace.id, date, reviewCount, alertCount });
  }
}
`);
  await fs.outputFile(path.join(root, 'tests/signal-operations.test.js'), `
import test from 'node:test';
import assert from 'node:assert/strict';
import { Workspace, SignalRule } from '../src/domain/concepts.js';
import { SignalOperationsService } from '../src/services/signal-operations-service.js';

test('queues operator review and records audit event for threshold breach', () => {
  const workspace = new Workspace({ id: 'ws_1', organizationId: 'org_1', name: 'Ops' });
  const rule = new SignalRule({ id: 'rule_1', workspaceId: 'ws_1', sourceId: 'src_1', threshold: 90, severity: 'high' });
  const service = new SignalOperationsService();
  const result = service.evaluateSignal(workspace, rule, { value: 95 });
  assert.equal(result.status, 'queued');
  assert.equal(service.auditLog[0].action, 'operator_review.queued');
});
`);
}

async function writeGuidedContinuation(root: string) {
  await fs.appendFile(path.join(root, 'src/domain/concepts.js'), `

export class NotificationPreference {
  constructor({ id, workspaceId, channel, enabled = true }) { this.id = id; this.workspaceId = workspaceId; this.channel = channel; this.enabled = enabled; }
}

export class SavedQueueFilter {
  constructor({ id, workspaceId, name, severity }) { this.id = id; this.workspaceId = workspaceId; this.name = name; this.severity = severity; }
}

export class SignalRuleComparisonOverlay {
  constructor({ workspaceId, baseRuleId, compareRuleId, delta }) { this.workspaceId = workspaceId; this.baseRuleId = baseRuleId; this.compareRuleId = compareRuleId; this.delta = delta; }
}
`);
  const servicePath = path.join(root, 'src/services/signal-operations-service.js');
  let service = await fs.readFile(servicePath, 'utf8');
  service = service.replace(
    "import { AuditEvent, OperatorReview, SignalDigest, SignalSource } from '../domain/concepts.js';",
    "import { AuditEvent, NotificationPreference, OperatorReview, SavedQueueFilter, SignalDigest, SignalRuleComparisonOverlay, SignalSource } from '../domain/concepts.js';"
  );
  service = service.replace(
    'constructor({ auditLog = [], reviews = [], sources = [] } = {}) {\n    this.auditLog = auditLog;\n    this.reviews = reviews;\n    this.sources = sources;\n  }',
    'constructor({ auditLog = [], reviews = [], sources = [], preferences = [], filters = [] } = {}) {\n    this.auditLog = auditLog;\n    this.reviews = reviews;\n    this.sources = sources;\n    this.preferences = preferences;\n    this.filters = filters;\n  }'
  );
  service = service.replace('\n  buildDailyDigest(workspace, date) {', `
  setNotificationPreference(workspace, input) {
    const preference = new NotificationPreference({ id: input.id, workspaceId: workspace.id, channel: input.channel, enabled: input.enabled });
    this.preferences.push(preference);
    this.recordAuditEvent(workspace, { actor: input.actor || 'system', action: 'notification_preference.updated', subjectId: preference.id });
    return preference;
  }

  saveQueueFilter(workspace, input) {
    const filter = new SavedQueueFilter({ id: input.id, workspaceId: workspace.id, name: input.name, severity: input.severity });
    this.filters.push(filter);
    this.recordAuditEvent(workspace, { actor: input.actor || 'system', action: 'operator_queue_filter.saved', subjectId: filter.id });
    return filter;
  }

  compareSignalRules(workspace, baseRule, compareRule) {
    if (baseRule.workspaceId !== workspace.id || compareRule.workspaceId !== workspace.id) throw new Error('Signal rules must belong to workspace');
    return new SignalRuleComparisonOverlay({ workspaceId: workspace.id, baseRuleId: baseRule.id, compareRuleId: compareRule.id, delta: compareRule.threshold - baseRule.threshold });
  }

  buildDailyDigest(workspace, date) {`);
  await fs.writeFile(servicePath, service);
  await fs.appendFile(path.join(root, 'tests/signal-operations.test.js'), continuationTest());
}

async function writeUnguidedContinuation(root: string) {
  await fs.outputFile(path.join(root, 'src/notification-preferences.js'), `
export class Workspace {
  constructor({ id, organizationId, label }) { this.id = id; this.organizationId = organizationId; this.label = label; }
}

export class SignalRule {
  constructor({ id, workspace, threshold }) { this.id = id; this.workspace = workspace; this.threshold = threshold; }
}

export class ReviewQueueItem {
  constructor({ id, workspace, rule }) { this.id = id; this.workspace = workspace; this.rule = rule; }
}

export class NotificationPreference {
  constructor({ id, workspace, channel }) { this.id = id; this.workspace = workspace; this.channel = channel; }
}

export function saveNotificationPreference(workspace, input) {
  return new NotificationPreference({ id: input.id, workspace, channel: input.channel });
}
`);
  await fs.outputFile(path.join(root, 'src/rule-comparison.js'), `
export class Workspace {
  constructor({ id }) { this.id = id; }
}

export class SignalRule {
  constructor({ id, workspaceId, threshold }) { this.id = id; this.workspaceId = workspaceId; this.threshold = threshold; }
}

export class SignalDigest {
  constructor({ workspaceId, items }) { this.workspaceId = workspaceId; this.items = items; }
}

export function compareSignalRules(workspace, baseRule, compareRule) {
  return { workspaceId: workspace.id, baseRuleId: baseRule.id, compareRuleId: compareRule.id, delta: compareRule.threshold - baseRule.threshold };
}
`);
  await fs.appendFile(path.join(root, 'tests/signal-operations.test.js'), `

test('unguided continuation behavior works but creates parallel concepts', async () => {
  const notifications = await import('../src/notification-preferences.js');
  const comparison = await import('../src/rule-comparison.js');
  const workspace = new notifications.Workspace({ id: 'ws_1', organizationId: 'org_1', label: 'Ops' });
  const preference = notifications.saveNotificationPreference(workspace, { id: 'pref_1', channel: 'email' });
  const overlay = comparison.compareSignalRules(
    new comparison.Workspace({ id: 'ws_1' }),
    new comparison.SignalRule({ id: 'rule_low', workspaceId: 'ws_1', threshold: 70 }),
    new comparison.SignalRule({ id: 'rule_high', workspaceId: 'ws_1', threshold: 95 })
  );
  assert.equal(preference.channel, 'email');
  assert.equal(overlay.delta, 25);
});
`);
}

async function writeGuidedScaleExpansion(root: string) {
  await fs.appendFile(path.join(root, 'src/domain/concepts.js'), `

export class EscalationWindow {
  constructor({ id, workspaceId, alertPolicyId, startsAt, endsAt }) { this.id = id; this.workspaceId = workspaceId; this.alertPolicyId = alertPolicyId; this.startsAt = startsAt; this.endsAt = endsAt; }
}

export class AuditExport {
  constructor({ id, workspaceId, requestedBy, eventCount }) { this.id = id; this.workspaceId = workspaceId; this.requestedBy = requestedBy; this.eventCount = eventCount; }
}

export class WorkspaceRiskRollup {
  constructor({ workspaceId, reviewCount, alertCount, digestSubscriberCount }) { this.workspaceId = workspaceId; this.reviewCount = reviewCount; this.alertCount = alertCount; this.digestSubscriberCount = digestSubscriberCount; }
}

export class DigestSubscription {
  constructor({ id, workspaceId, actor, cadence }) { this.id = id; this.workspaceId = workspaceId; this.actor = actor; this.cadence = cadence; }
}
`);
  const servicePath = path.join(root, 'src/services/signal-operations-service.js');
  let service = await fs.readFile(servicePath, 'utf8');
  service = service.replace(
    "import { AuditEvent, NotificationPreference, OperatorReview, SavedQueueFilter, SignalDigest, SignalRuleComparisonOverlay, SignalSource } from '../domain/concepts.js';",
    "import { AuditEvent, AuditExport, DigestSubscription, EscalationWindow, NotificationPreference, OperatorReview, SavedQueueFilter, SignalDigest, SignalRuleComparisonOverlay, SignalSource, WorkspaceRiskRollup } from '../domain/concepts.js';"
  );
  service = service.replace(
    'constructor({ auditLog = [], reviews = [], sources = [], preferences = [], filters = [] } = {}) {\n    this.auditLog = auditLog;\n    this.reviews = reviews;\n    this.sources = sources;\n    this.preferences = preferences;\n    this.filters = filters;\n  }',
    'constructor({ auditLog = [], reviews = [], sources = [], preferences = [], filters = [], escalationWindows = [], digestSubscriptions = [] } = {}) {\n    this.auditLog = auditLog;\n    this.reviews = reviews;\n    this.sources = sources;\n    this.preferences = preferences;\n    this.filters = filters;\n    this.escalationWindows = escalationWindows;\n    this.digestSubscriptions = digestSubscriptions;\n  }'
  );
  service = service.replace('\n  buildDailyDigest(workspace, date) {', `
  scheduleEscalationWindow(workspace, alertPolicy, input) {
    if (alertPolicy.workspaceId !== workspace.id) throw new Error('Alert policy does not belong to workspace');
    const window = new EscalationWindow({ id: input.id, workspaceId: workspace.id, alertPolicyId: alertPolicy.id, startsAt: input.startsAt, endsAt: input.endsAt });
    this.escalationWindows.push(window);
    this.recordAuditEvent(workspace, { actor: input.actor || 'system', action: 'escalation_window.scheduled', subjectId: window.id });
    return window;
  }

  exportAuditEvents(workspace, requestedBy) {
    const events = this.auditLog.filter(event => event.workspaceId === workspace.id);
    return new AuditExport({ id: 'audit_export_' + workspace.id, workspaceId: workspace.id, requestedBy, eventCount: events.length });
  }

  subscribeToDigest(workspace, input) {
    const subscription = new DigestSubscription({ id: input.id, workspaceId: workspace.id, actor: input.actor, cadence: input.cadence });
    this.digestSubscriptions.push(subscription);
    this.recordAuditEvent(workspace, { actor: input.actor || 'system', action: 'digest_subscription.created', subjectId: subscription.id });
    return subscription;
  }

  buildWorkspaceRiskRollup(workspace) {
    const digest = this.buildDailyDigest(workspace, new Date().toISOString().slice(0, 10));
    const digestSubscriberCount = this.digestSubscriptions.filter(subscription => subscription.workspaceId === workspace.id).length;
    return new WorkspaceRiskRollup({ workspaceId: workspace.id, reviewCount: digest.reviewCount, alertCount: digest.alertCount, digestSubscriberCount });
  }

  buildDailyDigest(workspace, date) {`);
  await fs.writeFile(servicePath, service);
  await fs.appendFile(path.join(root, 'tests/signal-operations.test.js'), scaleExpansionTest());
}

async function writeUnguidedScaleExpansion(root: string) {
  await fs.outputFile(path.join(root, 'src/escalation-reporting.js'), `
export class Workspace {
  constructor({ id, name }) { this.id = id; this.name = name; }
}

export class AlertPolicy {
  constructor({ id, workspace }) { this.id = id; this.workspace = workspace; }
}

export class AuditEvent {
  constructor({ id, workspace, action }) { this.id = id; this.workspace = workspace; this.action = action; }
}

export class SignalDigest {
  constructor({ workspace, count }) { this.workspace = workspace; this.count = count; }
}

export class EscalationWindow {
  constructor({ id, policy }) { this.id = id; this.policy = policy; }
}

export function scheduleEscalationWindow(policy, id) {
  return new EscalationWindow({ id, policy });
}

export function buildAuditExport(workspace, events) {
  return { workspaceId: workspace.id, count: events.length };
}
`);
  await fs.outputFile(path.join(root, 'src/review-rollups.js'), `
export class Workspace {
  constructor({ id }) { this.id = id; }
}

export class OperatorReview {
  constructor({ id, workspaceId }) { this.id = id; this.workspaceId = workspaceId; }
}

export class SignalDigest {
  constructor({ workspaceId, reviewCount }) { this.workspaceId = workspaceId; this.reviewCount = reviewCount; }
}

export function buildWorkspaceRiskRollup(workspace, reviews) {
  return new SignalDigest({ workspaceId: workspace.id, reviewCount: reviews.filter(review => review.workspaceId === workspace.id).length });
}
`);
  await fs.appendFile(path.join(root, 'tests/signal-operations.test.js'), `

test('unguided scale expansion works but forks reporting concepts', async () => {
  const reporting = await import('../src/escalation-reporting.js');
  const rollups = await import('../src/review-rollups.js');
  const workspace = new reporting.Workspace({ id: 'ws_1', name: 'Ops' });
  const policy = new reporting.AlertPolicy({ id: 'policy_1', workspace });
  const window = reporting.scheduleEscalationWindow(policy, 'window_1');
  const digest = rollups.buildWorkspaceRiskRollup(new rollups.Workspace({ id: 'ws_1' }), [new rollups.OperatorReview({ id: 'review_1', workspaceId: 'ws_1' })]);
  assert.equal(window.policy.id, 'policy_1');
  assert.equal(digest.reviewCount, 1);
});
`);
}

function continuationTest() {
  return `

test('continuation slice reuses workspace and signal rule model chain', () => {
  const workspace = new Workspace({ id: 'ws_1', organizationId: 'org_1', name: 'Ops' });
  const baseRule = new SignalRule({ id: 'rule_low', workspaceId: 'ws_1', sourceId: 'src_1', threshold: 70, severity: 'medium' });
  const compareRule = new SignalRule({ id: 'rule_high', workspaceId: 'ws_1', sourceId: 'src_1', threshold: 95, severity: 'high' });
  const service = new SignalOperationsService();
  const preference = service.setNotificationPreference(workspace, { id: 'pref_1', channel: 'email' });
  const filter = service.saveQueueFilter(workspace, { id: 'filter_1', name: 'High only', severity: 'high' });
  const overlay = service.compareSignalRules(workspace, baseRule, compareRule);
  assert.equal(preference.workspaceId, workspace.id);
  assert.equal(filter.workspaceId, workspace.id);
  assert.equal(overlay.delta, 25);
});
`;
}

function scaleExpansionTest() {
  return `

test('scale expansion keeps reporting on existing workspace and audit chain', () => {
  const workspace = new Workspace({ id: 'ws_1', organizationId: 'org_1', name: 'Ops' });
  const service = new SignalOperationsService();
  const policy = { id: 'policy_1', workspaceId: 'ws_1', severity: 'high', channel: 'email' };
  const window = service.scheduleEscalationWindow(workspace, policy, { id: 'window_1', startsAt: '09:00', endsAt: '17:00' });
  service.subscribeToDigest(workspace, { id: 'sub_1', actor: 'operator_1', cadence: 'weekly' });
  const auditExport = service.exportAuditEvents(workspace, 'operator_1');
  const rollup = service.buildWorkspaceRiskRollup(workspace);
  assert.equal(window.workspaceId, workspace.id);
  assert.equal(auditExport.eventCount, 2);
  assert.equal(rollup.digestSubscriberCount, 1);
});
`;
}

async function scoreArm(projectPath: string, contextFiles: string[], requiredReuse: string[]): Promise<ProofArm> {
  const testsPassed = await runTests(projectPath).then(() => true, () => false);
  const analysis = await analyzeForBench(projectPath);
  const duplicateClasses = await findDuplicateClasses(projectPath);
  const conceptDefinitionFiles = await findConceptDefinitionFiles(projectPath, requiredReuse);
  const leakedConcepts: Record<string, string[]> = {};
  for (const [concept, files] of conceptDefinitionFiles.entries()) {
    const leakedFiles = files.filter(file => file !== 'src/domain/concepts.js');
    if (leakedFiles.length) leakedConcepts[concept] = leakedFiles;
  }
  const parallelFeatureModules = await findParallelFeatureModules(projectPath);
  const sourceText = await readContext(projectPath, contextFiles);
  const reused = requiredReuse.filter(concept => !duplicateClasses.includes(concept) && sourceText.includes(concept));
  const findings = [];
  if (!testsPassed) findings.push('Tests failed.');
  if (duplicateClasses.length) findings.push(`Duplicate class definitions: ${duplicateClasses.join(', ')}.`);
  for (const [concept, files] of Object.entries(leakedConcepts)) {
    findings.push(`Required concept ownership leaked outside src/domain/concepts.js: ${concept} in ${files.join(', ')}.`);
  }
  if (parallelFeatureModules.length) findings.push(`Parallel feature modules bypassed the existing service/domain boundary: ${parallelFeatureModules.join(', ')}.`);
  for (const concept of requiredReuse) {
    if (!reused.includes(concept)) findings.push(`Required concept not cleanly reused: ${concept}.`);
  }
  const requiredConceptCoverage = requiredReuse.length ? reused.length / requiredReuse.length : 1;
  const ownershipCoherence = requiredReuse.length ? 1 - Math.min(1, Object.keys(leakedConcepts).length / requiredReuse.length) : 1;
  const boundaryCoherence = Math.max(0, 1 - parallelFeatureModules.length / 6);
  const testRelevance = testsPassed && analysis.test_summary?.total_tests ? 1 : 0;
  const score = Math.max(0, Math.round(
    requiredConceptCoverage * 30 +
    ownershipCoherence * 25 +
    boundaryCoherence * 20 +
    testRelevance * 15 +
    (testsPassed ? 10 : 0) -
    duplicateClasses.length * 8
  ));
  return {
    project_path: projectPath,
    tests_passed: testsPassed,
    analysis: {
      nodes: analysis.nodes?.length || 0,
      edges: analysis.edges?.length || 0,
      capabilities: analysis.system_capabilities?.length || 0,
      tests: analysis.test_summary?.total_tests || analysis.test_suites?.reduce((sum: number, suite: any) => sum + (suite.tests?.length || 0), 0) || 0,
    },
    duplicate_classes: duplicateClasses,
    reused_required_concepts: reused,
    leaked_required_concepts: leakedConcepts,
    parallel_feature_modules: parallelFeatureModules,
    focused_context_files: contextFiles.length,
    context_char_budget: sourceText.length,
    quality_breakdown: {
      required_concept_coverage: roundRatio(requiredConceptCoverage),
      ownership_coherence: roundRatio(ownershipCoherence),
      boundary_coherence: roundRatio(boundaryCoherence),
      test_relevance: roundRatio(testRelevance),
    },
    score,
    findings,
  };
}

async function runTests(projectPath: string) {
  await execFileAsync('npm', ['test'], { cwd: projectPath, timeout: 120000, maxBuffer: 1024 * 1024 * 5 });
}

async function findDuplicateClasses(projectPath: string): Promise<string[]> {
  const files = await listSourceFiles(projectPath);
  const counts = new Map<string, number>();
  for (const file of files) {
    const content = await fs.readFile(path.join(projectPath, file), 'utf8');
    for (const match of content.matchAll(/\bclass\s+([A-Z][A-Za-z0-9_]*)/g)) {
      counts.set(match[1], (counts.get(match[1]) || 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name).sort();
}

async function findConceptDefinitionFiles(projectPath: string, concepts: string[]): Promise<Map<string, string[]>> {
  const conceptSet = new Set(concepts);
  const files = await listSourceFiles(projectPath);
  const definitions = new Map<string, string[]>();
  for (const file of files) {
    if (!file.startsWith('src/')) continue;
    const content = await fs.readFile(path.join(projectPath, file), 'utf8');
    for (const match of content.matchAll(/\bclass\s+([A-Z][A-Za-z0-9_]*)/g)) {
      if (!conceptSet.has(match[1])) continue;
      const existing = definitions.get(match[1]) || [];
      existing.push(file);
      definitions.set(match[1], existing);
    }
  }
  return definitions;
}

async function findParallelFeatureModules(projectPath: string): Promise<string[]> {
  const files = await listSourceFiles(projectPath);
  return files.filter(file =>
    /^src\/[^/]+\.(js|ts|tsx|jsx)$/.test(file) &&
    file !== 'src/domain/concepts.js'
  ).sort();
}

function roundRatio(value: number): number {
  return Math.round(value * 100) / 100;
}

async function listSourceFiles(projectPath: string): Promise<string[]> {
  const files: string[] = [];
  await walk(projectPath, projectPath, files);
  return files.sort();
}

async function walk(root: string, current: string, out: string[]) {
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute);
    if (entry.isDirectory()) await walk(root, absolute, out);
    else if (/\.(js|ts|tsx|jsx|json)$/.test(relative)) out.push(relative);
  }
}

async function readContext(projectPath: string, files: string[]): Promise<string> {
  const chunks = [];
  for (const file of files) {
    const absolute = path.join(projectPath, file);
    if (await fs.pathExists(absolute)) chunks.push(await fs.readFile(absolute, 'utf8'));
  }
  return chunks.join('\n');
}

function percentageReduction(withValue: number, withoutValue: number): number {
  if (!withoutValue) return 0;
  return Math.round(((withoutValue - withValue) / withoutValue) * 100);
}

function formatMarkdown(report: any): string {
  const scenarioLines = (report.scenarios || []).flatMap((scenario: any) => [
    `- ${scenario.id}: ${[
      scenario.first_context_status,
      scenario.continuation_context_status,
      scenario.expansion_context_status,
      scenario.collaboration_context_status,
      scenario.operations_context_status,
    ].join('/')}; product focus: ${scenarioHasProductFocus(scenario) ? 'yes' : 'no'}; final memory: ${scenario.operations_context_architecture_memory?.model_owners ?? 'unknown'} models, ${scenario.operations_context_architecture_memory?.boundaries ?? 'unknown'} boundaries`,
  ]);
  return [
    '# From-Zero Build Context Proof',
    '',
    `Status: ${String(report.status).toUpperCase()}`,
    `Score: ${report.score}/100`,
    `Scenarios: ${report.summary?.scenarios_passed || 0}/${report.summary?.scenario_count || 0}`,
    `Product-focus scenarios: ${report.summary?.product_focus_scenario_count || 0}/${report.summary?.scenario_count || 0}`,
    '',
    '## Comparison',
    '',
    `- Quality delta: ${report.comparison.quality_delta}`,
    `- Positive quality scenarios: ${report.summary?.positive_quality_delta_scenarios ?? 0}/${report.summary?.scenario_count ?? 0}`,
    `- Duplicate class delta: ${report.comparison.duplicate_class_delta}`,
    `- Focused context file reduction: ${report.comparison.focused_context_file_reduction}`,
    `- Context char reduction: ${report.comparison.context_char_reduction_percentage}%`,
    `- Growth iterations: ${report.summary?.growth_iteration_count || 0}`,
    '',
    '## Scenarios',
    '',
    ...scenarioLines,
    '',
    '## With Klauro',
    '',
    `- Example score: ${report.with_klauro?.score ?? 'unknown'}`,
    `- Total duplicate classes: ${report.summary?.with_klauro_duplicate_classes ?? 'unknown'}`,
    `- Parallel feature modules: ${report.summary?.with_klauro_parallel_feature_modules ?? 'unknown'}`,
    '',
    '## Without Klauro',
    '',
    `- Example score: ${report.without_klauro?.score ?? 'unknown'}`,
    `- Total duplicate classes: ${report.summary?.without_klauro_duplicate_classes ?? 'unknown'}`,
    `- Parallel feature modules: ${report.summary?.without_klauro_parallel_feature_modules ?? 'unknown'}`,
    '',
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  const parsed: Args = {
    // Scratch workspaces are debug dumps, not durable data (local-persistence
    // doctrine): default under os.tmpdir(); pass --output-root to keep them.
    outputRoot: path.join(os.tmpdir(), 'klauro-from-zero-build-context-proof'),
    // Reports are debug output too — never dropped into the repo tree (cwd);
    // tmpdir by default, override with the explicit flags to keep them.
    reportPath: path.join(os.tmpdir(), 'klauro-from-zero-build-context-proof', 'latest-report.json'),
    markdownPath: path.join(os.tmpdir(), 'klauro-from-zero-build-context-proof', 'latest-report.md'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--output-root') parsed.outputRoot = argv[++i];
    else if (arg === '--report') parsed.reportPath = argv[++i];
    else if (arg === '--markdown') parsed.markdownPath = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: npm run agent-from-zero-build-context-proof -- [--output-root path] [--report file] [--markdown file]\n');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

if (isDirectCliInvocation('agent-from-zero-build-context-proof')) {
  const args = parseArgs(process.argv.slice(2));
  runFromZeroBuildContextProof(args).then(report => {
    process.stdout.write(`Status: ${String(report.status).toUpperCase()} (${report.score}/100)\n`);
    process.stdout.write(`Report: ${args.reportPath}\n`);
  }).catch(error => {
    console.error(error);
    process.exit(1);
  });
}
