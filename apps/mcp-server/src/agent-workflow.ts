import * as path from 'path';
import type { CASBehavioralInvariant, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { buildCapabilityMemoryForAgent, getAgentStartContext, getAgentContext, type AgentTask } from './agent-adoption';
import { assessBehavioralInvariantImpact, validateBehavioralInvariants } from './invariant-validation';
import { buildIdiomContextForAgent, validateCodebaseIdioms } from './idiom-query';
import { assessChangeRisk, buildSummary, findTests, getSystemOverview } from './query';

type GateStatus = 'pass' | 'warn' | 'fail';

export interface AgentWorkflowTask extends AgentTask {
  change_type?: 'add' | 'modify' | 'delete' | 'refactor' | 'rename' | 'schema' | 'test';
  files?: string[];
  diff_text?: string;
  plan_text?: string;
}

export interface AgentChangeReviewOptions {
  task?: AgentWorkflowTask;
  target?: string;
  files?: string[];
  diffText?: string;
  planText?: string;
  includeWorkingTree?: boolean;
}

export async function openAgentWorkbench(cas: CASOutput, projectPath: string, task: AgentWorkflowTask = {}) {
  const normalizedTask = normalizeWorkflowTask(task);
  const startContext = getAgentStartContext(cas, projectPath, normalizedTask);
  const agentContext = await getAgentContext(cas, projectPath, normalizedTask);
  const rules = buildCodebaseAgentRules(cas, projectPath, {
    target: normalizedTask.target,
    files: normalizedTask.files,
    limit: 10,
  });
  const signalQuality = buildSignalQuality(cas);

  return {
    product: 'agent_workbench',
    generated_at: new Date().toISOString(),
    path: projectPath,
    status: agentContext.status,
    task: normalizedTask,
    agent_directive: {
      agent_context_ready: startContext.readiness.agent_context_ready,
      rule: 'Use this workbench before broad source exploration. Read only the file_read_plan first, then expand from concrete CAS evidence or source gaps.',
      first_action: agentContext.file_read_plan.length > 0
        ? `Inspect ${agentContext.file_read_plan[0].file}`
        : 'Resolve a concrete target with search_nodes or get_agent_context before editing.',
      stop_conditions: [
        'Target resolution is ambiguous and no user clarification or source confirmation exists.',
        'Preflight or post-edit validation returns fail.',
        'CAS reports a gap that direct source reading cannot resolve confidently.',
      ],
    },
    orientation: {
      system: startContext.system,
      scale: startContext.scale,
      readiness: startContext.readiness,
      starting_points: startContext.starting_points,
    },
    task_context: {
      target_resolution: agentContext.target_resolution,
      selected_node: agentContext.selected_node,
      work_context: agentContext.work_context,
      file_read_plan: agentContext.file_read_plan,
      execution_brief: agentContext.execution_brief,
      execution_capsule: agentContext.execution_brief?.capsule,
      validation_plan: agentContext.validation_plan,
      source_reading_rule: agentContext.source_reading_rule,
      gaps: agentContext.gaps,
    },
    agent_rules: rules.rules,
    signal_quality: signalQuality,
    evidence_policy: buildEvidencePolicy(agentContext, rules),
    next_mcp_calls: compactToolPlan(agentContext.next_mcp_calls),
  };
}

export async function preflightAgentChange(
  cas: CASOutput,
  projectPath: string,
  options: AgentChangeReviewOptions = {},
) {
  const task = normalizeWorkflowTask({
    ...(options.task || {}),
    target: options.target || options.task?.target,
    files: options.files || options.task?.files,
    diff_text: options.diffText || options.task?.diff_text,
    plan_text: options.planText || options.task?.plan_text,
  });
  const agentContext = await getAgentContext(cas, projectPath, {
    ...task,
    task_type: task.task_type || 'modify',
  });
  const changedFiles = normalizeFiles(options.files || task.files || parseFilesFromDiff(options.diffText || task.diff_text || ''));
  const diffText = options.diffText || task.diff_text || '';
  const planText = options.planText || task.plan_text || task.instructions || '';
  const target = options.target || task.target || agentContext.selected_node?.id || undefined;
  const idiomImpact = buildFocusedIdiomContext(cas, {
    target,
    files: changedFiles.length ? changedFiles : agentContext.file_read_plan.map((item: any) => item.file),
    limit: 10,
  });
  const capabilityMemory = buildCapabilityMemoryForAgent(cas, {
    target,
    instructions: planText,
    files: changedFiles.length ? changedFiles : agentContext.file_read_plan.map((item: any) => item.file),
    limit: 8,
  });
  const invariantImpact = assessFocusedInvariantImpact(cas, {
    target,
    files: changedFiles,
    diffText,
    limit: 12,
  });
  const planSignals = inspectPlanSignals(planText, diffText, changedFiles);
  const risks = target ? assessChangeRisk(cas, target) : null;
  const requiredChecks = uniqueStrings([
    ...extractValidationCommands(agentContext.validation_plan),
    ...(Array.isArray(invariantImpact.required_checks) ? invariantImpact.required_checks : []),
    ...idiomImpact.validation,
    ...planSignals.required_checks,
  ]).slice(0, 20);
  const findings = [
    ...preflightFindingsFromTarget(agentContext),
    ...preflightFindingsFromPlanSignals(planSignals, idiomImpact, invariantImpact),
  ];
  const status = aggregateStatus(findings.map(finding => finding.status));
  const signalQuality = buildSignalQuality(cas);

  return {
    product: 'agent_change_preflight',
    generated_at: new Date().toISOString(),
    path: projectPath,
    status,
    verdict: verdictForStatus(status),
    task,
    change_shape: describeChangeShape(cas, { files: changedFiles, diffText, planText, target }),
    target_resolution: agentContext.target_resolution,
    selected_node: agentContext.selected_node,
    likely_impacts: {
      risk: summarizeRisk(risks),
      capability_memory: capabilityMemory,
      idioms: idiomImpact,
      invariants: invariantImpact,
      tests: agentContext.work_context?.tests || null,
    },
    findings,
    signal_quality: signalQuality,
    required_checks: requiredChecks,
    plan_output_block: buildPlanOutputBlock(status, findings, requiredChecks),
    next_mcp_calls: [
      { tool: 'get_coding_context', when: 'before editing the selected target', args: { path: projectPath, target: target || '<target>' } },
      { tool: 'validate_agent_change', when: 'after editing or before final response', args: { path: projectPath, target: target || '<target>', files: changedFiles } },
    ],
  };
}

export function buildCodebaseAgentRules(
  cas: CASOutput,
  projectPath: string,
  options: { target?: string; files?: string[]; limit?: number } = {},
) {
  const summary = buildSummary(cas);
  const overview = getSystemOverview(cas);
  const idiomContext = buildFocusedIdiomContext(cas, {
    target: options.target,
    files: options.files,
    limit: options.limit || 12,
  });
  const capabilityMemory = buildCapabilityMemoryForAgent(cas, {
    target: options.target,
    files: options.files,
    limit: options.limit || 8,
  });
  const invariants = selectImportantInvariants(cas, options);
  const tests = findTests(cas, { limit: 8 });
  const signalQuality = buildSignalQuality(cas);

  const rules = {
    identity: {
      name: summary.name || path.basename(projectPath),
      type: summary.type || overview.architecture_summary?.system_type || 'unknown',
      languages: summary.languages,
      frameworks: summary.frameworks,
      primary_domain: summary.primary_domain,
      description: summary.description,
    },
    default_agent_rule: 'Ask Klauro for target, file_read_plan, idioms, invariants, and validation checks before broad source exploration or edits.',
    architecture_rules: architectureRules(summary, overview),
    capability_rules: capabilityMemory.matched_capabilities.map((capability: any) => ({
      id: capability.id,
      name: capability.name,
      score: capability.score,
      rule: 'Check this existing capability before creating overlapping behavior.',
      operation_paths: capability.operation_paths,
      related_entities: capability.related_entities,
    })),
    reuse_decisions_required: capabilityMemory.reuse_decisions_required,
    idiom_rules: idiomContext.selected_idioms.map((idiom: any) => ({
      id: idiom.id,
      category: idiom.category,
      confidence: idiom.confidence,
      rule: idiom.name,
      do: idiom.do,
      avoid: idiom.avoid,
      validation: idiom.validation,
    })),
    invariant_rules: invariants.map(invariant => ({
      id: invariant.id,
      type: invariant.invariant_type,
      confidence: invariant.confidence,
      rule: invariant.name,
      scope: invariant.scope,
      checks: invariant.gaps?.length
        ? [`Resolve invariant gaps: ${invariant.gaps.slice(0, 3).join('; ')}`]
        : ['Preserve this invariant when touching scoped files, entities, or tests.'],
    })),
    testing_rules: testingRules(tests),
    source_reading_rules: [
      'Use file_read_plan before opening broad directories.',
      'Use capability_memory before adding a new capability so existing behavior is reused, extended, extracted, or explicitly distinguished.',
      'Prefer local examples from get_idiom_examples before creating new patterns.',
      'Treat low-confidence facts as leads that require source confirmation.',
      'After edits, run validate_agent_change before finalizing.',
    ],
  };

  return {
    product: 'codebase_agent_rules',
    generated_at: new Date().toISOString(),
    path: projectPath,
    rules,
    evidence: {
      nodes: summary.nodes,
      edges: summary.edges,
      entry_points: summary.entry_points,
      exit_points: (cas.exit_points || []).length,
      idioms: cas.codebase_idioms?.length || 0,
      invariants: cas.behavioral_invariants?.length || 0,
      tests: Array.isArray((tests as any).suites) ? (tests as any).suites.length : 0,
    },
    signal_quality: signalQuality,
    confidence_notes: buildConfidenceNotes(cas),
  };
}

export function explainChangeShape(
  cas: CASOutput,
  projectPath: string,
  options: AgentChangeReviewOptions = {},
) {
  const files = normalizeFiles(options.files || parseFilesFromDiff(options.diffText || ''));
  const target = options.target || options.task?.target;
  const diffText = options.diffText || options.task?.diff_text || '';
  const planText = options.planText || options.task?.plan_text || '';
  const shape = describeChangeShape(cas, { files, diffText, planText, target });
  const targetNodes = resolveFilesToNodes(cas, files).slice(0, 25);
  const tests = findTests(cas, { nodeId: targetNodes[0]?.id, limit: 10 });
  const invariantImpact = assessFocusedInvariantImpact(cas, { target, files, diffText, limit: 12 });
  const idiomContext = buildFocusedIdiomContext(cas, { target, files, limit: 10 });
  const signalQuality = buildSignalQuality(cas);

  return {
    product: 'change_shape_explanation',
    generated_at: new Date().toISOString(),
    path: projectPath,
    status: shape.files.changed.length || target || planText ? 'ready' : 'needs-input',
    shape,
    affected_graph: {
      nodes: targetNodes.map(compactNode),
      node_count: targetNodes.length,
      edge_count: countEdgesTouchingNodes(cas, targetNodes.map(node => node.id)),
    },
    affected_tests: tests,
    affected_idioms: idiomContext,
    affected_invariants: invariantImpact,
    signal_quality: signalQuality,
    confidence_notes: buildConfidenceNotes(cas),
    explanation: narrativeChangeExplanation(shape, targetNodes.length, invariantImpact.impacted_count || 0, idiomContext.selected_idioms.length),
  };
}

export function validateAgentChange(
  cas: CASOutput,
  projectPath: string,
  options: AgentChangeReviewOptions = {},
) {
  const files = normalizeFiles(options.files || options.task?.files || parseFilesFromDiff(options.diffText || options.task?.diff_text || ''));
  const diffText = options.diffText || options.task?.diff_text;
  const target = options.target || options.task?.target;
  const includeWorkingTree = options.includeWorkingTree !== false && !files.length && !diffText;
  const idioms = validateCodebaseIdioms(cas, projectPath, {
    target,
    files,
    diffText,
    includeWorkingTree,
    limit: 25,
  });
  const invariants = validateFocusedBehavioralInvariants(cas, projectPath, {
    target,
    files,
    diffText,
    includeWorkingTree,
    limit: 25,
  });
  const shape = describeChangeShape(cas, {
    files: files.length ? files : idioms.changed_files || invariants.changed_files || [],
    diffText: diffText || '',
    planText: options.planText || options.task?.plan_text || '',
    target,
  });
  const findings = [
    ...validationFindings('idiom', idioms),
    ...validationFindings('invariant', invariants),
    ...postEditShapeFindings(shape, idioms, invariants),
  ];
  const status = aggregateStatus([
    idioms.status as GateStatus,
    invariants.status as GateStatus,
    ...findings.map(finding => finding.status),
  ]);
  const signalQuality = buildSignalQuality(cas);

  return {
    product: 'agent_change_validation',
    generated_at: new Date().toISOString(),
    path: projectPath,
    status,
    verdict: verdictForStatus(status),
    target: target || null,
    change_shape: shape,
    idiom_validation: idioms,
    invariant_validation: invariants,
    findings,
    signal_quality: signalQuality,
    required_checks: uniqueStrings([
      ...(idioms.required_checks || []),
      ...(invariants.required_checks || []),
      ...findings.map(finding => finding.recommendation).filter(Boolean),
    ]).slice(0, 24),
    finalization_rule: status === 'fail'
      ? 'Advisory: review and fix failing idiom or invariant findings before finalizing, then rerun validate_agent_change.'
      : status === 'warn'
        ? 'Advisory: address or explicitly explain warnings and run the relevant checks before finalizing.'
        : 'Advisory: no CAS idiom or invariant concerns were found; still run the listed checks and review the edited source.',
  };
}

function normalizeWorkflowTask(task: AgentWorkflowTask): AgentWorkflowTask {
  return {
    ...task,
    files: normalizeFiles(task.files || parseFilesFromDiff(task.diff_text || '')),
  };
}

function describeChangeShape(
  cas: CASOutput,
  input: { files?: string[]; diffText?: string; planText?: string; target?: string },
) {
  const files = normalizeFiles(input.files || []);
  const diffText = input.diffText || '';
  const planText = input.planText || '';
  const addedLines = countMatches(diffText, /^\+(?!\+\+)/gm);
  const removedLines = countMatches(diffText, /^-(?!--)/gm);
  const touchedNodes = resolveFilesToNodes(cas, files);
  const sourceFiles = files.filter(isSourcePath);
  const testFiles = files.filter(isTestPath);
  const migrationFiles = files.filter(isMigrationPath);
  const schemaFiles = files.filter(isSchemaPath);
  const categories = uniqueStrings([
    ...sourceFiles.map(() => 'source'),
    ...testFiles.map(() => 'tests'),
    ...migrationFiles.map(() => 'migrations'),
    ...schemaFiles.map(() => 'schema'),
    ...(mentionsAuth(planText, diffText, files) ? ['auth-or-tenant'] : []),
    ...(mentionsApi(planText, diffText, files) ? ['api-contract'] : []),
  ]);

  return {
    target: input.target || null,
    files: {
      changed: files,
      source: sourceFiles,
      tests: testFiles,
      migrations: migrationFiles,
      schema: schemaFiles,
    },
    diff: {
      present: Boolean(diffText.trim()),
      added_lines: addedLines,
      removed_lines: removedLines,
    },
    categories,
    touched_nodes: touchedNodes.slice(0, 20).map(compactNode),
    inferred_scope: inferScope(categories, touchedNodes.length, addedLines, removedLines),
  };
}

function inspectPlanSignals(planText: string, diffText: string, files: string[]) {
  const text = `${planText}\n${diffText}`.toLowerCase();
  const sourceFiles = files.filter(isSourcePath);
  const testFiles = files.filter(isTestPath);
  const migrationFiles = files.filter(isMigrationPath);
  const schemaFiles = files.filter(isSchemaPath);
  const requiredChecks: string[] = [];
  const warnings: string[] = [];

  if ((text.includes('auth') || text.includes('tenant') || text.includes('organization')) && testFiles.length === 0) {
    warnings.push('Plan appears to touch auth/tenant behavior but does not include test files.');
    requiredChecks.push('Add or update focused auth/tenant tests, or explain why existing tests cover the change.');
  }
  if (schemaFiles.length > 0 && migrationFiles.length === 0) {
    warnings.push('Schema/entity files are included without a migration file.');
    requiredChecks.push('Add or verify the required migration for schema changes.');
  }
  if (sourceFiles.length > 0 && testFiles.length === 0 && /\b(add|change|modify|fix|remove|refactor)\b/.test(text)) {
    warnings.push('Behavioral source change has no matching test file in the proposed file set.');
    requiredChecks.push('Inspect nearby tests and add/update focused coverage if behavior changes.');
  }

  return { warnings, required_checks: requiredChecks };
}

function buildFocusedIdiomContext(cas: CASOutput, options: { target?: string; files?: string[]; limit?: number }) {
  const focused = buildIdiomContextForAgent(cas, options);
  if (focused.selected_idioms.length > 0) return focused;
  if (options.target) {
    const withoutTarget = buildIdiomContextForAgent(cas, {
      files: options.files,
      limit: options.limit,
    });
    if (withoutTarget.selected_idioms.length > 0) {
      return {
        ...withoutTarget,
        target_resolution_note: `No idioms matched target "${options.target}" directly; returned file/global idioms instead.`,
      };
    }
  }
  return focused;
}

function assessFocusedInvariantImpact(
  cas: CASOutput,
  options: { target?: string; files?: string[]; diffText?: string; invariantType?: string; limit?: number },
) {
  const focused = assessBehavioralInvariantImpact(cas, options);
  if ((focused.impacted_count || 0) > 0) return focused;
  if (options.target && options.files?.length) {
    const fileFocused = assessBehavioralInvariantImpact(cas, {
      files: options.files,
      diffText: options.diffText,
      invariantType: options.invariantType,
      limit: options.limit,
    });
    if ((fileFocused.impacted_count || 0) > 0) {
      return {
        ...fileFocused,
        target: options.target,
        target_resolution_note: `No invariants matched target "${options.target}" directly; returned file-scoped invariant impact instead.`,
      };
    }
  }
  return focused;
}

function validateFocusedBehavioralInvariants(
  cas: CASOutput,
  projectPath: string,
  options: {
    target?: string;
    files?: string[];
    diffText?: string;
    includeWorkingTree?: boolean;
    limit?: number;
  },
) {
  const focused = validateBehavioralInvariants(cas, projectPath, options);
  if ((focused.invariant_impact?.impacted_count || 0) > 0 || !options.target || !options.files?.length) return focused;
  const fileFocused = validateBehavioralInvariants(cas, projectPath, {
    files: options.files,
    diffText: options.diffText,
    includeWorkingTree: options.includeWorkingTree,
    limit: options.limit,
  });
  if ((fileFocused.invariant_impact?.impacted_count || 0) > 0 || fileFocused.status !== 'pass') {
    return {
      ...fileFocused,
      target: options.target,
      target_resolution_note: `No invariants matched target "${options.target}" directly; validated file-scoped invariants instead.`,
    };
  }
  return focused;
}

function preflightFindingsFromTarget(agentContext: any) {
  const findings = [];
  if (agentContext.target_resolution?.gaps?.length) {
    findings.push({
      id: 'target-resolution-gap',
      status: 'warn' as GateStatus,
      severity: 'warning',
      evidence_source: 'workflow-resolution',
      message: agentContext.target_resolution.gaps.join('; '),
      recommendation: 'Confirm the intended target before editing.',
    });
  }
  if (!agentContext.file_read_plan?.length) {
    findings.push({
      id: 'missing-file-read-plan',
      status: 'warn' as GateStatus,
      severity: 'warning',
      evidence_source: 'workflow-resolution',
      message: 'No concrete files were resolved for the task.',
      recommendation: 'Use search_nodes or a more specific target so Klauro can narrow source reads.',
    });
  }
  return findings;
}

function preflightFindingsFromPlanSignals(planSignals: ReturnType<typeof inspectPlanSignals>, idiomContext: any, invariantImpact: any) {
  const findings = planSignals.warnings.map((warning, index) => ({
    id: `plan-signal-${index + 1}`,
    status: 'warn' as GateStatus,
    severity: 'warning',
    evidence_source: 'plan-text-heuristic',
    message: warning,
    recommendation: planSignals.required_checks[index] || 'Review the proposed change shape before editing.',
  }));
  if ((invariantImpact.impacted_count || 0) > 0) {
    findings.push({
      id: 'behavioral-invariant-impact',
      status: invariantImpact.status === 'fail' ? 'fail' as GateStatus : 'warn' as GateStatus,
      severity: invariantImpact.status === 'fail' ? 'error' : 'warning',
      evidence_source: 'cas-analysis',
      message: `${invariantImpact.impacted_count} behavioral invariant(s) may be affected.`,
      recommendation: 'Preserve or explicitly update affected invariants and run validate_behavioral_invariants after edits.',
    });
  }
  if (idiomContext.selected_idioms?.length) {
    findings.push({
      id: 'idiom-context-required',
      status: 'pass' as GateStatus,
      severity: 'info',
      evidence_source: 'cas-analysis',
      message: `${idiomContext.selected_idioms.length} repo-local idiom(s) apply to this change.`,
      recommendation: 'Follow idiom do/avoid guidance and run validate_codebase_idioms after edits.',
    });
  }
  return findings;
}

function validationFindings(kind: 'idiom' | 'invariant', result: any) {
  const findings = [];
  if (Array.isArray(result.violations)) {
    for (const violation of result.violations.slice(0, 12)) {
      findings.push({
        id: `${kind}-${violation.id || violation.category || findings.length + 1}`,
        status: violation.severity === 'error' ? 'fail' as GateStatus : 'warn' as GateStatus,
        severity: violation.severity || 'warning',
        evidence_source: 'cas-analysis',
        message: violation.message,
        file: violation.file,
        recommendation: violation.recommendation,
      });
    }
  }
  if (Array.isArray(result.failures)) {
    for (const failure of result.failures) {
      findings.push({
        id: `${kind}-failure-${findings.length + 1}`,
        status: 'fail' as GateStatus,
        severity: 'error',
        evidence_source: 'cas-analysis',
        message: failure,
        recommendation: `Resolve: ${failure}`,
      });
    }
  }
  if (Array.isArray(result.warnings)) {
    for (const warning of result.warnings) {
      findings.push({
        id: `${kind}-warning-${findings.length + 1}`,
        status: 'warn' as GateStatus,
        severity: 'warning',
        evidence_source: 'cas-analysis',
        message: warning,
        recommendation: `Review: ${warning}`,
      });
    }
  }
  return findings;
}

function postEditShapeFindings(shape: any, idioms: any, invariants: any) {
  const findings = [];
  if (shape.files.source.length > 0 && shape.files.tests.length === 0 && (idioms.status === 'warn' || invariants.status === 'warn')) {
    findings.push({
      id: 'source-change-without-tests',
      status: 'warn' as GateStatus,
      severity: 'warning',
      evidence_source: 'change-shape-heuristic',
      message: 'Source files changed while validation reported warnings and no tests changed.',
      recommendation: 'Run or add focused tests, or explain why the change is non-behavioral.',
    });
  }
  return findings;
}

function architectureRules(summary: any, overview: any): string[] {
  const patterns = Array.isArray(summary.architectural_patterns)
    ? summary.architectural_patterns
    : overview.architecture_summary?.architectural_patterns || [];
  const inventory = summary.architectural_inventory_counts || {};
  const balance = summary.pattern_balance || overview.architecture_summary?.pattern_balance;
  return uniqueStrings([
    summary.architecture_type ? `Respect the ${summary.architecture_type} architecture shape.` : '',
    patterns.length
      ? `Detected architecture patterns: ${patterns.slice(0, 6).map((pattern: any) => `${pattern.name} (${Math.round(Number(pattern.confidence || 0) * 100)}%)`).join(', ')}.`
      : 'No strong architecture pattern was detected; inspect nearby files before introducing a new pattern.',
    Object.keys(inventory).length
      ? `Architecture inventory: ${Object.entries(inventory).filter(([, count]) => Number(count) > 0).slice(0, 8).map(([kind, count]) => `${kind}=${count}`).join(', ')}.`
      : '',
    balance?.status && balance.status !== 'balanced'
      ? `Pattern balance is ${balance.status}: ${(balance.risks || []).slice(0, 2).join('; ')}`
      : '',
    ...patterns.slice(0, 5).map((pattern: any) => pattern.guidance).filter(Boolean),
    summary.database_entities?.length ? 'Treat database entities as contract-bearing nodes; schema changes need migration/test review.' : '',
    overview.runtime_static_links_count ? 'Runtime-linked behavior should be checked against static and runtime evidence when available.' : '',
    summary.entry_points ? 'Use entry points to reason from user/API triggers to internal behavior.' : '',
  ].filter(Boolean));
}

function testingRules(tests: any): string[] {
  const suites = Array.isArray(tests?.suites) ? tests.suites : [];
  if (suites.length === 0) return ['No tests were mapped by CAS; direct source/test discovery is required before claiming coverage.'];
  return uniqueStrings([
    `CAS mapped ${suites.length} test suite(s); prefer focused tests near the changed behavior.`,
    ...suites.slice(0, 5).map((suite: any) => `Relevant test style: ${suite.framework || suite.test_type || 'test'} in ${suite.file_path || suite.name}`),
  ]);
}

function selectImportantInvariants(cas: CASOutput, options: { target?: string; files?: string[]; limit?: number }): CASBehavioralInvariant[] {
  let invariants = cas.behavioral_invariants || [];
  const files = normalizeFiles(options.files || []);
  if (options.target || files.length) {
    const target = (options.target || '').toLowerCase();
    invariants = invariants.filter(invariant => {
      const text = [
        invariant.id,
        invariant.name,
        invariant.description,
        ...(invariant.scope?.file_paths || []),
        ...(invariant.scope?.entity_names || []),
        ...(invariant.scope?.field_names || []),
      ].join(' ').toLowerCase();
      return (target && text.includes(target)) ||
        files.some(file => (invariant.scope?.file_paths || []).some(scoped => pathsCompatible(file, scoped)));
    });
  }
  const selected = invariants.length ? invariants : (cas.behavioral_invariants || []);
  return selected
    .sort((left, right) => confidenceRank(right.confidence) - confidenceRank(left.confidence))
    .slice(0, options.limit || 8);
}

function buildSignalQuality(cas: CASOutput) {
  const anyCas = cas as any;
  const tests = Array.isArray(cas.test_suites) ? cas.test_suites.length : 0;
  const patterns = Array.isArray(cas.patterns) ? cas.patterns.length : 0;
  const capabilities = Array.isArray(cas.system_capabilities) ? cas.system_capabilities.length : 0;
  const idioms = Array.isArray(cas.codebase_idioms) ? cas.codebase_idioms.length : 0;
  const invariants = Array.isArray(cas.behavioral_invariants) ? cas.behavioral_invariants.length : 0;
  const errors = Array.isArray(cas.analysis_errors) ? cas.analysis_errors.length : 0;
  const systemType = String(anyCas.architecture_summary?.system_type || anyCas.system?.type || '');
  const purposeConfidence = typeof anyCas.system_purpose?.confidence === 'number'
    ? anyCas.system_purpose.confidence
    : typeof anyCas.enhanced_system_purpose?.confidence === 'number'
      ? anyCas.enhanced_system_purpose.confidence
      : null;
  const warnings = uniqueStrings([
    tests === 0 ? 'CAS mapped no test suites; test guidance is a source-discovery requirement, not coverage evidence.' : '',
    patterns === 0 ? 'CAS mapped no reusable patterns; agents should inspect local examples before creating or refactoring patterns.' : '',
    capabilities === 0 ? 'CAS mapped no system capabilities; duplicate-work avoidance requires direct source confirmation.' : '',
    idioms === 0 ? 'CAS detected no repo-local idioms; style and placement guidance needs direct source confirmation.' : '',
    invariants === 0 ? 'CAS detected no behavioral invariants; auth, tenant, data, and boundary assumptions need source confirmation.' : '',
    errors > 0 ? `${errors} analyzer error(s) were reported; omitted areas may be missing from this context.` : '',
    purposeConfidence !== null && purposeConfidence < 0.45 ? `System purpose confidence is low (${purposeConfidence.toFixed(2)}); treat summaries as orientation, not truth.` : '',
    isTestingSystemType(systemType) ? `Architecture system_type "${systemType}" looks like a test framework; treat architecture identity as suspect until re-analysis.` : '',
  ]);

  return {
    overall: warnings.length > 2 || errors > 0 ? 'limited' : warnings.length > 0 ? 'partial' : 'strong',
    counts: {
      nodes: cas.nodes?.length || 0,
      edges: cas.edges?.length || 0,
      entry_points: cas.entry_points?.length || 0,
      exit_points: cas.exit_points?.length || 0,
      tests,
      patterns,
      capabilities,
      idioms,
      invariants,
      analysis_errors: errors,
    },
    purpose_confidence: purposeConfidence,
    warnings,
  };
}

function buildConfidenceNotes(cas: CASOutput): string[] {
  const notes = [];
  const lowConfidenceInvariants = (cas.behavioral_invariants || []).filter(invariant => invariant.confidence === 'low').length;
  if (lowConfidenceInvariants > 0) notes.push(`${lowConfidenceInvariants} invariant(s) are low confidence and should be treated as source-confirmation leads.`);
  if ((cas.analysis_errors || []).length > 0) notes.push(`${cas.analysis_errors?.length} analyzer error(s) were reported; inspect analysis_errors before relying on omitted areas.`);
  if (!(cas.codebase_idioms || []).length) notes.push('No repo-local idioms were detected; agents should fall back to direct local examples.');
  if (!(cas.test_suites || []).length) notes.push('No test suites were mapped by CAS; this is missing signal, not evidence of no tests.');
  if (!(cas.patterns || []).length) notes.push('No reusable patterns were mapped by CAS; inspect local examples before claiming style or architecture fit.');
  if (!(cas.behavioral_invariants || []).length) notes.push('No behavioral invariants were mapped by CAS; confirm auth, tenancy, data, and boundary assumptions in source.');
  const systemType = String((cas as any).architecture_summary?.system_type || (cas as any).system?.type || '');
  if (isTestingSystemType(systemType)) notes.push(`Architecture identity looks suspect because system_type is "${systemType}".`);
  return notes.length ? notes : ['CAS contains evidence-backed rules; still confirm low-level implementation details in the named source files before editing.'];
}

function isTestingSystemType(systemType: string): boolean {
  return /\b(jest|vitest|mocha|jasmine|cypress|playwright|testing-library)\b/i.test(systemType);
}

function buildEvidencePolicy(agentContext: any, rules: any) {
  return {
    known_facts: [
      'Node, edge, entry point, exit point, test, idiom, and invariant facts come from CAS analysis.',
      'File-read plans are source-confirmation targets, not a replacement for reading edited code.',
    ],
    inferred_facts: [
      'Idioms and behavioral invariants can include inferred guidance; check confidence and evidence counts.',
      'Plan-only preflight is advisory until a diff or file bundle is supplied.',
    ],
    must_confirm_in_source: uniqueStrings([
      ...(agentContext.file_read_plan || []).slice(0, 5).map((item: any) => item.file),
      ...(rules.confidence_notes || []).some((note: string) => note.includes('low confidence')) ? 'Low-confidence invariants' : '',
    ].filter(Boolean)),
  };
}

function compactToolPlan(steps: any[] = []) {
  return steps.slice(0, 12).map(step => ({
    order: step.order,
    tool: step.tool,
    args: step.args,
    purpose: step.purpose,
    required: step.required,
  }));
}

function buildPlanOutputBlock(status: GateStatus, findings: any[], requiredChecks: string[]) {
  return {
    title: 'Klauro Preflight',
    status,
    verdict: verdictForStatus(status),
    include_in_agent_plan: true,
    bullets: [
      `Verdict: ${verdictForStatus(status)}`,
      ...findings.slice(0, 5).map(finding => `${finding.severity}: ${finding.message}`),
      ...requiredChecks.slice(0, 5).map(check => `Required check: ${check}`),
    ],
  };
}

function extractValidationCommands(validationPlan: any): string[] {
  const commands = Array.isArray(validationPlan?.commands) ? validationPlan.commands : [];
  const manual = Array.isArray(validationPlan?.manual_checks) ? validationPlan.manual_checks : [];
  return [
    ...commands.map((command: any) => command.command ? `${command.command} (${command.purpose || command.scope || 'validation'})` : ''),
    ...manual,
  ].filter(Boolean);
}

function summarizeRisk(risk: any) {
  if (!risk) return null;
  const summary = risk.change_risk_summary || risk.risk || risk;
  return {
    level: risk.risk?.level || summary?.level || null,
    impact_score: risk.risk?.impact_score || summary?.impact_score || null,
    affected_nodes: Array.isArray(summary?.affected_nodes) ? summary.affected_nodes.length : undefined,
    recommendation: risk.risk?.recommendation || summary?.recommendation || 'Inspect assess_change_risk for full detail.',
  };
}

function narrativeChangeExplanation(shape: any, nodeCount: number, invariantCount: number, idiomCount: number): string[] {
  const lines = [];
  lines.push(`This appears to be a ${shape.inferred_scope} change touching ${shape.files.changed.length} file(s) and ${nodeCount} mapped CAS node(s).`);
  if (shape.categories.length) lines.push(`Primary categories: ${shape.categories.join(', ')}.`);
  if (invariantCount > 0) lines.push(`${invariantCount} behavioral invariant(s) may need preservation or explicit update.`);
  if (idiomCount > 0) lines.push(`${idiomCount} repo-local idiom(s) should guide placement, style, tests, and boundaries.`);
  if (shape.files.tests.length === 0 && shape.files.source.length > 0) lines.push('No changed test files were supplied for the source change.');
  return lines;
}

function resolveFilesToNodes(cas: CASOutput, files: string[]) {
  if (!files.length) return [];
  const nodes = cas.nodes.filter(node => node.source?.file && files.some(file => pathsCompatible(file, node.source!.file!)));
  return nodes.sort((left, right) => sourceRank(left.type) - sourceRank(right.type)).slice(0, 100);
}

function compactNode(node: any) {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    category: node.category,
    file: node.source?.file,
    line: node.source?.line,
  };
}

function countEdgesTouchingNodes(cas: CASOutput, nodeIds: string[]) {
  const ids = new Set(nodeIds);
  return cas.edges.filter(edge => ids.has(edge.source) || ids.has(edge.target)).length;
}

function inferScope(categories: string[], nodeCount: number, addedLines: number, removedLines: number): string {
  if (categories.includes('schema')) return 'schema-contract';
  if (categories.includes('auth-or-tenant')) return 'security-boundary';
  if (categories.includes('api-contract')) return 'api-contract';
  if (nodeCount > 20 || addedLines + removedLines > 250) return 'multi-node';
  if (categories.includes('tests') && categories.length === 1) return 'test-only';
  return 'localized';
}

function sourceRank(type: string): number {
  if (['controller', 'service', 'module', 'class', 'function', 'method'].includes(type)) return 0;
  if (['entity', 'repository', 'dto', 'guard', 'middleware'].includes(type)) return 1;
  if (type.includes('test')) return 2;
  return 3;
}

function confidenceRank(confidence: string): number {
  if (confidence === 'high') return 3;
  if (confidence === 'medium') return 2;
  if (confidence === 'low') return 1;
  return 0;
}

function verdictForStatus(status: GateStatus): string {
  if (status === 'fail') return 'does_not_fit_yet';
  if (status === 'warn') return 'fits_with_warnings';
  return 'fits';
}

function aggregateStatus(statuses: GateStatus[]): GateStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

function parseFilesFromDiff(diffText: string): string[] {
  const files = new Set<string>();
  for (const line of diffText.split(/\r?\n/)) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) {
      files.add(match[2]);
      continue;
    }
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) files.add(fileMatch[1]);
  }
  return [...files];
}

function normalizeFiles(files: string[]): string[] {
  return uniqueStrings(files.map(file => file.replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean));
}

function pathsCompatible(left: string, right: string): boolean {
  const a = left.replace(/\\/g, '/').replace(/^\.\//, '');
  const b = right.replace(/\\/g, '/').replace(/^\.\//, '');
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function isSourcePath(file: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|cs|java|php|dart)$/i.test(file) && !isTestPath(file);
}

function isTestPath(file: string): boolean {
  return /(^|\/)(__tests__|tests?|spec|e2e|cypress)(\/|$)|(\.|_|-)(test|spec|cy)\.[a-z0-9]+$/i.test(file);
}

function isMigrationPath(file: string): boolean {
  return /(^|\/)(migrations?|db\/migrate|prisma\/migrations)(\/|$)|migration/i.test(file);
}

function isSchemaPath(file: string): boolean {
  return /(^|\/)(schema|models?|entities?|database|prisma)(\/|$)|(\.prisma|schema\.sql)$/i.test(file);
}

function mentionsAuth(planText: string, diffText: string, files: string[]): boolean {
  const text = `${planText}\n${diffText}\n${files.join('\n')}`.toLowerCase();
  return /\b(auth|tenant|organization|permission|guard|jwt|scope)\b/.test(text);
}

function mentionsApi(planText: string, diffText: string, files: string[]): boolean {
  const text = `${planText}\n${diffText}\n${files.join('\n')}`.toLowerCase();
  return /\b(route|controller|endpoint|api|request|response|dto|handler)\b/.test(text);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
