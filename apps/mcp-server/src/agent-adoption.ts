import * as fs from 'fs';
import * as nodePath from 'path';
import type { CASEntryPoint, CASOutput, CASNode, SystemCapability } from '../../../packages/analyzer-core/src/types/cas.types';
import {
  assessChangeRisk,
  buildSummary,
  findTests,
  getCallees,
  getCallChain,
  getCallers,
  getBehavioralInvariants,
  getCodingContext,
  getEntryPoints,
  getErrorContracts,
  getExitPoints,
  getFlowCoverage,
  getRuntimeStaticLinks,
  getSecurityOverview,
  searchNodes,
} from './query';
import { describeAnswerPackCatalog, runAnswerPack } from './product';
import { semanticSearch } from './semantic-search';
import type { TestDiscoveryEvidence } from './test-discovery';
import { assessBehavioralInvariantImpact } from './invariant-validation';
import { buildIdiomContextForAgent } from './idiom-query';
import { summarizeAnalysisFreshness, type AnalysisFreshnessSummary } from './freshness';
import { journeyHeadline } from './journey-presentation';
import {
  classifyAnalysisProfile,
  expectedCallChainCount,
  expectedEntryPointCount,
  expectedMethodCallCount,
  gateExpectation,
  type AnalysisProfile,
} from './analysis-profile';

export type AgentTaskType = 'orient' | 'modify' | 'debug' | 'review' | 'trace' | 'cross-repo' | 'runtime';
type GateStatus = 'pass' | 'warn' | 'fail';

export interface AgentTask {
  task_type?: AgentTaskType;
  target?: string;
  related_paths?: string[];
  runtime_event?: Record<string, unknown>;
  instructions?: string;
  success_criteria?: string[];
}

interface AgentToolStep {
  order: number;
  tool: string;
  args: Record<string, unknown>;
  purpose: string;
  required: boolean;
}

interface AgentReadinessGate {
  id: string;
  status: GateStatus;
  score: number;
  detail: string;
}

export interface AgentReadinessReport {
  path: string;
  name: string;
  generated_at: string;
  status: GateStatus;
  score: number;
  default_use: boolean;
  summary: {
    nodes: number;
    edges: number;
    entry_points: number;
    exit_points: number;
    call_chains: number;
    method_calls: number;
    runtime_static_links: number;
    analysis_facts: number;
    codebase_idioms: number;
    tests: number;
    analysis_errors: number;
    behavioral_invariants?: {
      total: number;
      gaps: number;
    };
    test_discovery?: {
      status: string;
      source_test_files: number;
      potential_uncovered_test_files: number;
    };
  };
  profile: AnalysisProfile;
  gates: AgentReadinessGate[];
  adoption_gaps: string[];
  required_agent_behavior: string[];
  test_discovery?: TestDiscoveryEvidence;
}

interface FileReadPlanItem {
  file: string;
  reason: string;
  node_ids: string[];
  line?: number;
  line_window?: {
    start: number;
    end: number;
    instruction: string;
  };
}

interface AgentTestSuiteRef {
  file_path?: string;
  name?: string;
}

interface AgentValidationCommand {
  command: string;
  purpose: string;
  scope: 'focused-test' | 'typecheck' | 'build' | 'broad-test';
  files?: string[];
  confidence: number;
}

interface AgentValidationPlan {
  strategy: string;
  commands: AgentValidationCommand[];
  tests_to_inspect: Array<{ file: string; name?: string; reason: string }>;
  manual_checks: string[];
  run_policy: string;
  environment_rule: string;
  gaps: string[];
}

export function getAgentStartContext(cas: CASOutput, path: string, task: AgentTask = {}) {
  const summary = buildSummary(cas);
  const answerPack = runAnswerPack(cas, path);
  const readiness = evaluateAgentReadiness(cas, path);
  const architectureContext = buildArchitectureContextForAgent(cas, {
    target: task.target,
    limit: 6,
  });
  const topNodes = mostConnectedNodes(cas).slice(0, 8).map(node => ({
    id: node.id,
    name: node.name,
    type: node.type,
    file: node.source?.file,
    line: node.source?.line,
  }));
  const entryPoints = getEntryPoints(cas, { limit: 8 });
  const exitPoints = getExitPoints(cas, { limit: 8 });
  const runtimeLinks = getRuntimeStaticLinks(cas, { limit: 8 });
  const productOrientation = buildProductOrientationLine(cas);
  const sensitiveDataExposure = buildSensitiveExposureDigest(cas);
  const analysisFreshness = summarizeAnalysisFreshness(path, cas.analysis_timestamp);

  return {
    path,
    generated_at: new Date().toISOString(),
    default_rule: 'Use this CAS-backed MCP context before broad file reads. Read source files after MCP narrows the target or reports a gap. After edits, run validate_behavioral_invariants and validate_codebase_idioms before finalizing changes.',
    task: normalizeTask(task),
    ...(sensitiveDataExposure ? { sensitive_data_exposure: sensitiveDataExposure } : {}),
    ...(analysisFreshness ? { analysis_freshness: analysisFreshness } : {}),
    readiness: {
      status: readiness.status,
      score: readiness.score,
      default_use: readiness.default_use,
      profile: readiness.profile,
      gaps: readiness.adoption_gaps,
      language_coverage_note: unanalyzedLanguageNote(cas),
    },
    system: {
      name: summary.name,
      type: summary.type,
      description: summary.description,
      primary_domain: summary.primary_domain,
      architecture_type: summary.architecture_type,
      languages: summary.languages,
      frameworks: summary.frameworks,
      top_capabilities: summary.top_capabilities,
    },
    ...(productOrientation ? { product_orientation: productOrientation } : {}),
    scale: {
      nodes: summary.nodes,
      edges: summary.edges,
      entry_points: summary.entry_points,
      entry_points_by_type: summary.entry_points_by_type,
      database_entities: summary.database_entities,
      capabilities: summary.capabilities,
      analysis_errors: summary.errors,
    },
    starting_points: {
      entry_points: entryPoints.entry_points.map(entry => ({
        id: entry.id,
        name: entry.name,
        type: entry.type,
        trigger: entry.trigger,
        handler: entry.handler,
      })),
      exit_points: exitPoints.exit_points.map(exitPoint => ({
        id: exitPoint.id,
        name: exitPoint.name,
        type: exitPoint.type,
        source_node: exitPoint.source_node,
        target: exitPoint.target,
      })),
      connected_nodes: topNodes,
      runtime_static_links: runtimeLinks.links,
    },
    idiom_summary: cas.idiom_summary || null,
    architecture_context: architectureContext,
    capability_memory: buildCapabilityMemoryForAgent(cas, {
      target: task.target,
      instructions: task.instructions,
      success_criteria: task.success_criteria,
      limit: 6,
    }),
    answer_pack: {
      status: answerPack.gaps.length === 0 ? 'ready' : 'needs-review',
      answers: answerPack.answers.map(answer => ({
        id: answer.id,
        confidence: answer.confidence,
        evidence_count: answer.evidence.length,
        follow_up_tools: answer.follow_up_tools,
      })),
      gaps: answerPack.gaps,
    },
    recommended_first_tools: getAgentToolPlan(cas, { path, task }).steps.slice(0, 6),
    when_to_read_files: [
      'When get_coding_context names the exact file or node to edit.',
      'When an MCP answer reports a gap that needs direct verification.',
      'When tests, logs, or source diffs must be inspected to complete the user task.',
    ],
  };
}

export async function getAgentWorkPacket(cas: CASOutput, path: string, taskInput: AgentTask = {}) {
  const task = normalizeTask(taskInput);
  const readiness = evaluateAgentReadiness(cas, path);
  const plan = getAgentToolPlan(cas, { path, task });
  const baseTargetQuery = task.target || inferTargetQueryFromTask(task);
  const targetQuery = enrichTargetQueryWithCapabilityEvidence(cas, baseTargetQuery);
  let targetResolution = await resolveTaskTarget(cas, path, targetQuery);
  if (!targetResolution.selected_node && baseTargetQuery && targetQuery && baseTargetQuery !== targetQuery) {
    targetResolution = await resolveTaskTarget(cas, path, baseTargetQuery);
  }
  const selectedNode = targetResolution.selected_node;
  const tests = selectedNode
    ? findTests(cas, { nodeId: selectedNode.id, limit: 10 })
    : findTests(cas, { limit: 10 });
  const callers = selectedNode ? getCallers(cas, selectedNode.id, 2, 25) : null;
  const callees = selectedNode ? getCallees(cas, selectedNode.id, 2, 25) : null;
  const risk = selectedNode ? assessChangeRisk(cas, selectedNode.id) : null;
  const riskForAgent = summarizeRiskForAgent(risk);
  const codingContext = selectedNode || targetQuery || task.target
    ? getCodingContext(cas, selectedNode?.id || targetQuery || task.target || '', { task_type: workPacketTaskType(task.task_type) })
    : null;
  const errorContracts = selectedNode && task.task_type === 'debug'
    ? getErrorContracts(cas, selectedNode.id, 'both')
    : null;
  const behavioralInvariants = getBehavioralInvariants(cas, {
    target: selectedNode?.id || targetQuery || task.target,
    limit: 12,
  });
  const entryContext = buildEntryContext(cas, task, selectedNode?.id);
  let fileReadPlan = buildFileReadPlan(cas, selectedNode || undefined, callers, callees, tests, entryContext);
  const requestedTargetFile = targetQuery ? normalizeTargetFileForAgent(path, cas.system?.root_path, targetQuery) : null;
  if (requestedTargetFile && !fileReadPlan.some(item => item.file === requestedTargetFile)) {
    fileReadPlan = [targetFileReadPlanItem(requestedTargetFile), ...fileReadPlan].slice(0, 12);
  }
  fileReadPlan = augmentFileReadPlanWithTaskHints(cas, fileReadPlan, task).slice(0, 12);
  const invariantImpact = assessBehavioralInvariantImpact(cas, {
    target: selectedNode?.id || targetQuery || task.target,
    files: fileReadPlan.map(item => item.file),
    limit: 12,
  });
  const compactTests = summarizeTestsForAgent(tests);
  const compactBehavioralInvariants = summarizeBehavioralInvariantsForAgent(behavioralInvariants);
  const compactInvariantImpact = summarizeInvariantImpactForAgent(invariantImpact);
  const idiomContext = buildIdiomContextForAgent(cas, {
    target: selectedNode?.id || targetQuery || task.target,
    files: fileReadPlan.map(item => item.file),
    limit: 8,
  });
  const architectureTarget = targetQuery || task.target || selectedNode?.name || selectedNode?.id;
  const architectureFiles = fileReadPlan
    .filter(isArchitecturePlacementFileReadPlanItem)
    .map(item => item.file);
  const architectureContext = buildArchitectureContextForAgent(cas, {
    target: architectureTarget,
    files: architectureFiles.length > 0 ? architectureFiles : fileReadPlan.map(item => item.file),
    limit: 6,
  });
  const capabilityMemory = buildCapabilityMemoryForAgent(cas, {
    target: targetQuery || task.target || selectedNode?.name || selectedNode?.id,
    instructions: task.instructions,
    success_criteria: task.success_criteria,
    files: fileReadPlan.map(item => item.file),
    limit: 8,
  });
  const riskContext = buildRiskContextForAgent(cas, {
    targetNode: selectedNode || undefined,
    target: selectedNode?.id || targetQuery || task.target,
    files: fileReadPlan.map(item => item.file),
    limit: 6,
  });
  const pillarTargetFile = selectedNode?.source?.file
    ? normalizeSourceFile(selectedNode.source.file, cas.system?.root_path)
    : requestedTargetFile;
  const pillarEntityName = selectedNode && ['entity', 'class', 'model'].includes(String(selectedNode.type || '').toLowerCase())
    ? selectedNode.name
    : undefined;
  const journeyContext = buildJourneyContextForAgent(cas, { nodeId: selectedNode?.id, file: pillarTargetFile || undefined, entityName: pillarEntityName });
  const lineageContext = buildLineageContextForAgent(cas, { nodeId: selectedNode?.id, file: pillarTargetFile || undefined, entityName: pillarEntityName });
  const conformanceContext = buildConformanceContextForAgent(cas, { file: pillarTargetFile || undefined });
  const validationPlan = buildValidationPlan(path, cas, task, selectedNode || undefined, tests, fileReadPlan, risk, behavioralInvariants);
  const gaps = [
    ...readiness.adoption_gaps,
    ...targetResolution.gaps,
    ...(fileReadPlan.length === 0 ? ['file-read-plan: no concrete source files resolved'] : []),
    ...validationPlan.gaps.map(gap => `validation-plan: ${gap}`),
  ];

  const sensitiveDataExposure = buildSensitiveExposureDigest(cas);
  const analysisFreshness = buildWorkPacketFreshness(cas, path, selectedNode || undefined, fileReadPlan);
  if (analysisFreshness?.invalid_citations) {
    gaps.push('analysis-freshness: files cited by this packet changed or were deleted after analysis; re-run analyze_codebase before trusting citations');
  }
  const riskWithFreshness = analysisFreshness?.target_file_note && riskForAgent
    ? { ...riskForAgent, target_file_changed_since_analysis: analysisFreshness.target_file_note }
    : riskForAgent;

  const packet = {
    path,
    generated_at: new Date().toISOString(),
    task,
    status: gaps.length === 0 ? 'ready' : 'needs-review',
    default_use: readiness.default_use,
    ...(sensitiveDataExposure ? { sensitive_data_exposure: sensitiveDataExposure } : {}),
    ...(analysisFreshness ? { analysis_freshness: analysisFreshness.summary } : {}),
    readiness: {
      status: readiness.status,
      score: readiness.score,
      profile: readiness.profile,
      gaps: readiness.adoption_gaps,
      language_coverage_note: unanalyzedLanguageNote(cas),
    },
    target_resolution: summarizeTargetResolutionForAgent(targetResolution),
    selected_node: selectedNode ? summarizeNodeForAgent(selectedNode) : null,
    work_context: {
      coding_context: codingContext,
      risk: riskWithFreshness,
      risk_context: riskContext,
      callers,
      callees,
      tests: compactTests,
      error_contracts: errorContracts,
      behavioral_invariants: compactBehavioralInvariants,
      invariant_impact: compactInvariantImpact,
      architecture_context: architectureContext,
      idiom_context: idiomContext,
      system_health: summarizeSystemHealthForAgent(cas),
      capability_memory: capabilityMemory,
      entry_context: entryContext,
      ...(lineageContext ? { lineage_context: lineageContext } : {}),
      ...(journeyContext ? { journey_context: journeyContext } : {}),
      ...(conformanceContext ? { conformance_context: conformanceContext } : {}),
    },
    file_read_plan: fileReadPlan,
    invariant_impact: compactInvariantImpact,
    validation_plan: validationPlan,
    next_mcp_calls: plan.steps,
    source_reading_rule: 'Read only the files in file_read_plan first. Expand only when those files or MCP evidence show a concrete gap. Preserve idiom_context and system_health remediation rules when editing.',
    gaps,
  };

  return adaptWorkPacketForRepoScale(packet, cas);
}

const WORK_PACKET_CITATION_CHECK_LIMIT = 20;

interface WorkPacketFreshness {
  summary: AnalysisFreshnessSummary & {
    cited_files_changed_since_analysis?: string[];
    cited_files_deleted_since_analysis?: string[];
    warning?: string;
  };
  invalid_citations: boolean;
  target_file_note?: string;
}

function buildWorkPacketFreshness(
  cas: CASOutput,
  projectPath: string,
  selectedNode: CASNode | undefined,
  fileReadPlan: FileReadPlanItem[],
): WorkPacketFreshness | null {
  const base = summarizeAnalysisFreshness(projectPath, cas.analysis_timestamp);
  if (!base) return null;
  const analyzedAtMs = Date.parse(base.analyzed_at);
  const rootPath = cas.system?.root_path;
  const targetFile = selectedNode?.source?.file
    ? normalizeSourceFile(selectedNode.source.file, rootPath)
    : null;
  const citedFiles = uniqueStrings([
    ...(targetFile ? [targetFile] : []),
    ...fileReadPlan.map(item => item.file),
  ]).slice(0, WORK_PACKET_CITATION_CHECK_LIMIT);

  const changedCited: string[] = [];
  const deletedCited: string[] = [];
  for (const file of citedFiles) {
    const absolute = nodePath.isAbsolute(file) ? file : nodePath.join(projectPath, file);
    try {
      const stat = fs.statSync(absolute);
      if (stat.mtimeMs > analyzedAtMs) changedCited.push(file);
    } catch {
      deletedCited.push(file);
    }
  }

  const invalidCitations = changedCited.length > 0 || deletedCited.length > 0;
  if (!invalidCitations) return { summary: base, invalid_citations: false };

  let targetFileNote: string | undefined;
  if (targetFile && deletedCited.includes(targetFile)) {
    targetFileNote = `${targetFile} was deleted after this analysis was generated; this node no longer exists at the cited location and its risk assessment describes stale code.`;
  } else if (targetFile && changedCited.includes(targetFile)) {
    targetFileNote = `${targetFile} was modified after this analysis was generated; this node's line numbers, structure, and risk assessment may no longer match the source.`;
  }

  return {
    summary: {
      ...base,
      staleness: 'stale',
      cited_files_changed_since_analysis: changedCited.slice(0, 5),
      cited_files_deleted_since_analysis: deletedCited.slice(0, 5),
      warning: `STALE ANALYSIS: ${changedCited.length} file(s) cited by this packet changed and ${deletedCited.length} were deleted after the analysis was generated. Specific file/line citations in this packet may be invalid. Re-run analyze_codebase for ${projectPath} (incremental) before relying on them.`,
    },
    invalid_citations: true,
    target_file_note: targetFileNote,
  };
}

function buildProductOrientationLine(cas: CASOutput): string | null {
  const map = cas.product_map;
  if (!map) return null;
  const capabilities = (map.capabilities || []).slice(0, 3).map(capability => capability.name).filter(Boolean);
  const parts = [
    capabilities.length > 0 ? `Top capabilities: ${capabilities.join(', ')}` : '',
    typeof map.journeys?.total === 'number' ? `${map.journeys.total} journeys` : '',
    Array.isArray(map.data?.sensitive) ? `${map.data.sensitive.length} sensitive entities` : '',
  ].filter(Boolean);
  if (parts.length === 0) return null;
  const identity = [map.identity?.name, map.identity?.domain].filter(Boolean).join(' / ');
  return `${identity ? `${identity} — ` : ''}${parts.join('; ')}.`;
}

const CRITICALITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const DEVIATION_SEVERITY_RANK: Record<string, number> = { error: 0, warning: 1, info: 2 };
const PILLAR_DIGEST_TOKEN_BUDGET = 120;

function trimToPillarTokenBudget<T>(items: T[]): T[] {
  let selected = items;
  while (selected.length > 1 && JSON.stringify(selected).length > PILLAR_DIGEST_TOKEN_BUDGET * 4) {
    selected = selected.slice(0, -1);
  }
  return selected;
}

export function buildJourneyContextForAgent(
  cas: CASOutput,
  opts: { nodeId?: string; file?: string; entityName?: string } = {},
) {
  const journeys = cas.user_journeys || [];
  if (journeys.length === 0 || (!opts.nodeId && !opts.file && !opts.entityName)) return null;
  const rootPath = cas.system?.root_path;
  const nodeFiles = new Map<string, string>();
  for (const node of cas.nodes || []) {
    if (node.source?.file) nodeFiles.set(node.id, normalizeSourceFile(node.source.file, rootPath));
  }
  const targetFile = opts.file ? normalizeSourceFile(opts.file, rootPath) : '';
  const matching = journeys.filter(journey => {
    const journeyNodeIds = [
      journey.entry?.handler_node_id,
      ...(journey.steps || []).map(step => step.node_id),
      ...(journey.terminal_entities || []).map(terminal => terminal.node_id),
    ].filter((id): id is string => Boolean(id));
    if (opts.nodeId && journeyNodeIds.includes(opts.nodeId)) return true;
    if (opts.entityName) {
      if ((journey.terminal_entities || []).some(terminal => terminal.name === opts.entityName)) return true;
      const effects = journey.terminal_effects;
      if ((effects?.entities_written || []).includes(opts.entityName) || (effects?.entities_read || []).includes(opts.entityName)) return true;
    }
    if (!targetFile) return false;
    return journeyNodeIds.some(id => {
      const file = nodeFiles.get(id);
      return Boolean(file && projectPathsMatch(file, targetFile));
    });
  }).sort((a, b) => (CRITICALITY_RANK[a.criticality] ?? 4) - (CRITICALITY_RANK[b.criticality] ?? 4));
  if (matching.length === 0) return null;
  return {
    total_matching: matching.length,
    journeys: trimToPillarTokenBudget(matching.slice(0, 5).map(journey => ({
      id: journey.id,
      headline: journeyHeadline(journey).slice(0, 160),
      kind: journey.journey_kind,
      criticality: journey.criticality,
      boundaries: [...new Set((journey.security_boundaries || []).slice(0, 3).map(boundary => boundary.name))],
      tests: (journey.tests_covering || []).length,
    }))),
  };
}

const SENSITIVE_EXPOSURE_INSTRUCTION = 'Address or verify these sensitive-data exposure paths before answering security or data-exposure questions.';

type LineageRecord = NonNullable<CASOutput['data_lineage']>[number];

function lineageEntityHasExposure(item: LineageRecord): boolean {
  return Boolean(item.exposure?.sensitive && ((item.exposure?.unguarded_paths || 0) > 0 || item.exposure?.external_transfer));
}

function lineageExposureScore(item: LineageRecord): number {
  return (item.exposure?.unguarded_paths || 0) * 2 + (item.exposure?.external_transfer ? 1 : 0);
}

function lineageExposureLine(item: LineageRecord): string {
  const fields = (item.sensitive_fields || []).slice(0, 3);
  const fieldsSuffix = fields.length > 0 ? `, sensitive fields: ${fields.join(', ')}` : '';
  const nonAuth = item.exposure?.non_auth_guarded_paths || 0;
  const nonAuthSuffix = nonAuth > 0 ? ` (${nonAuth} with non-auth guards only)` : '';
  return `${item.entity_name}: ${item.exposure?.unguarded_paths || 0} unguarded paths${nonAuthSuffix}, external_transfer: ${Boolean(item.exposure?.external_transfer)}${fieldsSuffix}`;
}

export function buildSensitiveExposureDigest(cas: CASOutput, limit = 3) {
  const exposed = (cas.data_lineage || [])
    .filter(lineageEntityHasExposure)
    .sort((a, b) => lineageExposureScore(b) - lineageExposureScore(a) || a.entity_name.localeCompare(b.entity_name));
  if (exposed.length === 0) return null;
  return {
    instruction: SENSITIVE_EXPOSURE_INSTRUCTION,
    total_exposed_entities: exposed.length,
    highest_risk: exposed.slice(0, limit).map(lineageExposureLine),
  };
}

export function buildLineageContextForAgent(
  cas: CASOutput,
  opts: { nodeId?: string; file?: string; entityName?: string } = {},
) {
  const lineage = cas.data_lineage || [];
  if (lineage.length === 0 || (!opts.nodeId && !opts.file && !opts.entityName)) return null;
  const rootPath = cas.system?.root_path;
  const targetFile = opts.file ? normalizeSourceFile(opts.file, rootPath) : '';
  const accessorMatches = (accessor: { node_id?: string; file?: string }) => {
    if (opts.nodeId && accessor.node_id === opts.nodeId) return true;
    if (!targetFile || !accessor.file) return false;
    return projectPathsMatch(normalizeSourceFile(accessor.file, rootPath), targetFile);
  };
  const rows: Array<{ item: NonNullable<CASOutput['data_lineage']>[number]; writes: boolean; reads: boolean; isTargetEntity: boolean }> = [];
  for (const item of lineage) {
    const writes = (item.writers || []).some(accessorMatches);
    const reads = (item.readers || []).some(accessorMatches);
    const isTargetEntity = Boolean(opts.entityName && item.entity_name === opts.entityName);
    if (!writes && !reads && !isTargetEntity) continue;
    rows.push({ item, writes, reads, isTargetEntity });
  }
  if (rows.length === 0) return null;
  const exposureScore = (row: typeof rows[number]) =>
    (row.item.exposure?.sensitive ? 4 : 0) +
    ((row.item.exposure?.unguarded_paths || 0) > 0 ? 2 : 0) +
    (row.item.exposure?.external_transfer ? 1 : 0);
  rows.sort((a, b) =>
    Number(b.isTargetEntity) - Number(a.isTargetEntity) ||
    exposureScore(b) - exposureScore(a) ||
    Number(b.writes) - Number(a.writes) ||
    a.item.entity_name.localeCompare(b.item.entity_name));
  const highestRisk = rows.find(row => lineageEntityHasExposure(row.item));
  return {
    ...(highestRisk
      ? { headline: lineageExposureLine(highestRisk.item), instruction: SENSITIVE_EXPOSURE_INSTRUCTION }
      : {}),
    total_matching: rows.length,
    entities: trimToPillarTokenBudget(rows.slice(0, 5).map(({ item, writes, reads, isTargetEntity }) => ({
      entity: item.entity_name,
      access: writes && reads ? 'writes+reads' : writes ? 'writes' : reads ? 'reads' : (isTargetEntity ? 'target-entity' : 'reads'),
      writers: (item.writers || []).length,
      readers: (item.readers || []).length,
      sensitive: Boolean(item.exposure?.sensitive),
      ...(item.sensitive_fields?.length ? { sensitive_fields: item.sensitive_fields.slice(0, 3) } : {}),
      unguarded_paths: item.exposure?.unguarded_paths || 0,
      ...(item.exposure?.non_auth_guarded_paths ? { non_auth_guarded_paths: item.exposure.non_auth_guarded_paths } : {}),
      external_transfer: Boolean(item.exposure?.external_transfer),
    }))),
  };
}

export function buildConformanceContextForAgent(
  cas: CASOutput,
  opts: { file?: string } = {},
) {
  const paradigms = cas.paradigm_conformance || [];
  if (paradigms.length === 0 || !opts.file) return null;
  const rootPath = cas.system?.root_path;
  const targetFile = normalizeSourceFile(opts.file, rootPath);
  const moduleDir = targetFile.includes('/') ? targetFile.split('/').slice(0, -1).join('/') : '';
  const collect = (matches: (file: string) => boolean) => {
    const found: Array<{ paradigm: string; kind: string; severity: string; file: string; detail: string }> = [];
    for (const paradigm of paradigms) {
      for (const deviation of paradigm.deviations || []) {
        const file = normalizeSourceFile(deviation.file || '', rootPath);
        if (!file || !matches(file)) continue;
        const detail = String(deviation.detail || '');
        found.push({
          paradigm: paradigm.paradigm,
          kind: deviation.kind,
          severity: deviation.severity,
          file,
          detail: detail.length > 140 ? `${detail.slice(0, 137)}...` : detail,
        });
      }
    }
    return found;
  };
  let scope = 'file';
  let deviations = collect(file => projectPathsMatch(file, targetFile));
  if (deviations.length === 0 && moduleDir) {
    scope = 'module';
    const moduleLower = `${moduleDir.toLowerCase()}/`;
    deviations = collect(file => file.toLowerCase().startsWith(moduleLower));
  }
  if (deviations.length === 0) return null;
  deviations.sort((a, b) => (DEVIATION_SEVERITY_RANK[a.severity] ?? 3) - (DEVIATION_SEVERITY_RANK[b.severity] ?? 3));
  return {
    scope,
    total_matching: deviations.length,
    deviations: trimToPillarTokenBudget(deviations.slice(0, 5)),
  };
}

function compactPillarWorkContext(
  context: any,
  limits: { journeys: number; entities: number; deviations: number },
): Record<string, any> {
  const result: Record<string, any> = {};
  if (!context || typeof context !== 'object') return result;
  if (context.lineage_context?.entities?.length) {
    result.lineage_context = {
      ...(context.lineage_context.headline
        ? { headline: context.lineage_context.headline, instruction: context.lineage_context.instruction }
        : {}),
      total_matching: context.lineage_context.total_matching,
      entities: context.lineage_context.entities.slice(0, limits.entities),
    };
  }
  if (context.journey_context?.journeys?.length) {
    result.journey_context = {
      total_matching: context.journey_context.total_matching,
      journeys: context.journey_context.journeys.slice(0, limits.journeys).map((journey: any) => ({
        id: journey.id,
        headline: journey.headline,
        kind: journey.kind,
        criticality: journey.criticality,
        boundaries: Array.isArray(journey.boundaries) ? journey.boundaries.slice(0, 2) : journey.boundaries,
        tests: journey.tests,
      })),
    };
  }
  if (context.conformance_context?.deviations?.length) {
    result.conformance_context = {
      scope: context.conformance_context.scope,
      total_matching: context.conformance_context.total_matching,
      deviations: context.conformance_context.deviations.slice(0, limits.deviations).map((deviation: any) => ({
        paradigm: deviation.paradigm,
        kind: deviation.kind,
        severity: deviation.severity,
        file: deviation.file,
      })),
    };
  }
  return result;
}

function isArchitecturePlacementFileReadPlanItem(item: FileReadPlanItem): boolean {
  const reason = String(item.reason || '').toLowerCase();
  if (!reason) return false;
  if (/task hint|representative entry point|test coverage|focused test|validation/i.test(reason)) return false;
  return /selected target|explicit target|caller via|callee via/i.test(reason);
}

export function buildArchitectureContextForAgent(
  cas: CASOutput,
  opts: { target?: string; files?: string[]; limit?: number } = {},
) {
  const summary = cas.architecture_summary;
  const inventory = summary?.architectural_inventory;
  const patterns = summary?.architectural_patterns || [];
  const limit = opts.limit || 6;
  const nodeById = new Map((cas.nodes || []).map(node => [node.id, node]));
  const target = String(opts.target || '').toLowerCase();
  const targetTokens = architectureTargetTokens(target);
  const files = uniqueStrings((opts.files || []).map(file => normalizeSourceFile(file, cas.system?.root_path)));
  const fileSet = new Set(files.map((file: string) => file.toLowerCase()));

  const targetRelevantNodeIds = new Set<string>();
  if (target) {
    for (const node of cas.nodes || []) {
      const haystack = [
        node.id,
        node.name,
        node.qualified_name,
        node.type,
        node.source?.file,
      ].filter(Boolean).join(' ').toLowerCase();
      if (haystack.includes(target) || targetTokens.some(token => haystack.includes(token))) {
        targetRelevantNodeIds.add(node.id);
      }
    }
  }
  const fileRelevantNodeIds = new Set<string>();
  if (fileSet.size > 0) {
    for (const node of cas.nodes || []) {
      const file = normalizeSourceFile(node.source?.file || '', cas.system?.root_path).toLowerCase();
      if (!file) continue;
      if ([...fileSet].some((item: string) => projectPathsMatch(file, item))) fileRelevantNodeIds.add(node.id);
    }
  }
  const directRelevantNodeIds = new Set([...targetRelevantNodeIds, ...fileRelevantNodeIds]);
  const relevantNodeIds = new Set(directRelevantNodeIds);
  expandRelevantArchitectureNodeIds(relevantNodeIds, cas);

  const hasSpecificContext = Boolean(target || fileSet.size > 0 || relevantNodeIds.size > 0);
  const fileScopedDirectNodeIds = fileRelevantNodeIds.size > 0 ? fileRelevantNodeIds : directRelevantNodeIds;
  const fileScopedExpandedNodeIds = new Set(fileScopedDirectNodeIds);
  expandRelevantArchitectureNodeIds(fileScopedExpandedNodeIds, cas);
  const patternScopeNodeIds = fileSet.size > 0
    ? architectureFileScopedNodeIds(fileScopedDirectNodeIds, fileScopedExpandedNodeIds, nodeById, files, cas.system?.root_path)
    : relevantNodeIds;
  const inventoryScopeNodeIds = fileSet.size > 0
    ? architectureFileScopedNodeIds(fileScopedDirectNodeIds, fileScopedExpandedNodeIds, nodeById, files, cas.system?.root_path)
    : relevantNodeIds;
  const scopedFallbackPatterns = fileSet.size > 0
    ? synthesizeScopedArchitecturePatterns(inventory, inventoryScopeNodeIds, nodeById)
    : [];
  const relevantPatterns = patterns.filter(pattern => pattern.node_ids?.some(id => patternScopeNodeIds.has(id)));
  const selectedPatterns = uniqueByName(
    fileSet.size > 0
      ? [
        ...relevantPatterns,
        ...scopedFallbackPatterns,
      ]
      : hasSpecificContext
        ? [
          ...relevantPatterns,
          ...patterns.filter(pattern => pattern.confidence >= 0.65),
          ...patterns,
        ]
        : [
          ...patterns.filter(pattern => pattern.confidence >= 0.65),
          ...patterns,
        ],
  ).slice(0, limit);
  const relevantInventory = inventory
    ? Object.fromEntries(Object.entries(inventory)
      .map(([kind, ids]) => [
        kind,
        (Array.isArray(ids) ? ids as string[] : [])
          .filter(id => inventoryScopeNodeIds.size === 0 || inventoryScopeNodeIds.has(id))
          .filter(id => isUsefulArchitectureExampleNode(nodeById.get(id)))
          .slice(0, 8)
          .filter(id => fileSet.size === 0 || architectureNodeMatchesAnyScopeFile(nodeById.get(id), files, cas.system?.root_path))
          .map(id => compactArchitectureNode(nodeById.get(id), id))
          .filter(Boolean),
      ])
      .filter(([, nodes]) => Array.isArray(nodes) && nodes.length > 0))
    : {};
  const hasRelevantInventory = Object.keys(relevantInventory).length > 0;
  const scopedInventoryFallback = fileSet.size > 0
    ? synthesizeScopedArchitectureInventory(inventoryScopeNodeIds, nodeById, files, cas.system?.root_path)
    : {};
  const localInventory = fileSet.size > 0
    ? mergeArchitectureInventory(scopedInventoryFallback, relevantInventory)
    : relevantInventory;
  const inventoryExamples = hasSpecificContext && fileSet.size > 0
    ? localInventory
    : hasSpecificContext && hasRelevantInventory
    ? relevantInventory
    : hasSpecificContext && fileSet.size > 0
    ? scopedInventoryFallback
    : inventory
    ? Object.fromEntries(Object.entries(inventory)
      .map(([kind, ids]) => [
        kind,
        (Array.isArray(ids) ? ids as string[] : [])
          .filter(id => isUsefulArchitectureExampleNode(nodeById.get(id)))
          .slice(0, 6)
          .map(id => compactArchitectureNode(nodeById.get(id), id))
          .filter(Boolean),
      ])
      .filter(([, nodes]) => Array.isArray(nodes) && nodes.length > 0))
    : {};
  const patternDecisionMatrix = selectedPatterns
    .filter(pattern => pattern.category !== 'anti-pattern')
    .map(pattern => {
      const exampleIds = fileSet.size > 0
        ? (pattern.node_ids || []).filter(id => patternScopeNodeIds.has(id))
        : (pattern.node_ids || []);
      return {
        pattern: pattern.name,
        use_when: patternUseWhen(pattern.name, pattern.category),
        owner_categories: ownerCategoriesForPattern(pattern.name, pattern.category, inventory || undefined),
        examples: exampleIds
          .filter(id => isUsefulArchitectureExampleNode(nodeById.get(id)))
          .filter(id => fileSet.size === 0 || architectureNodeMatchesAnyScopeFile(nodeById.get(id), files, cas.system?.root_path))
          .slice(0, 5)
          .map(id => compactArchitectureNode(nodeById.get(id), id))
          .filter(Boolean),
        guidance: pattern.guidance,
      };
    });

  return {
    system_type: summary?.system_type || cas.system?.type || 'unknown',
    architecture_budget: selectedPatterns
      .filter(pattern => pattern.category !== 'anti-pattern')
      .slice(0, 5)
      .map(pattern => pattern.name),
    patterns: selectedPatterns.map(pattern => ({
      name: pattern.name,
      category: pattern.category,
      confidence: pattern.confidence,
      evidence: (pattern.evidence || []).slice(0, 3),
      guidance: pattern.guidance,
    })),
    inventory_counts: inventory ? Object.fromEntries(
      Object.entries(inventory).map(([kind, ids]) => [kind, Array.isArray(ids) ? ids.length : 0])
    ) : {},
    inventory_examples: inventoryExamples,
    relevant_inventory: localInventory,
    pattern_decision_matrix: patternDecisionMatrix,
    pattern_balance: summary?.pattern_balance || null,
    global_architecture_budget: hasSpecificContext ? patterns
      .filter(pattern => pattern.category !== 'anti-pattern' && pattern.confidence >= 0.65)
      .slice(0, 5)
      .map(pattern => pattern.name) : undefined,
    agent_rules: uniqueStrings([
      'Before adding a new architectural style, check whether an existing pattern and owner category already covers the feature.',
      ...selectedPatterns.map(pattern => pattern.guidance).filter(Boolean),
      ...(summary?.pattern_balance?.recommendations || []),
    ]).slice(0, 8),
  };
}

function synthesizeScopedArchitecturePatterns(
  inventory: NonNullable<CASOutput['architecture_summary']>['architectural_inventory'] | undefined,
  scopedNodeIds: Set<string>,
  nodeById: Map<string, CASNode>,
): NonNullable<NonNullable<CASOutput['architecture_summary']>['architectural_patterns']> {
  if (scopedNodeIds.size === 0) return [];

  const byKind = new Map<string, string[]>();
  for (const [kind, ids] of Object.entries(inventory || {})) {
    const scopedIds = (Array.isArray(ids) ? ids as string[] : [])
      .filter(id => scopedNodeIds.has(id))
      .filter(id => isUsefulArchitectureExampleNode(nodeById.get(id)));
    if (scopedIds.length > 0) byKind.set(kind, scopedIds);
  }

  if (byKind.size === 0) {
    const sourceIds = [...scopedNodeIds].filter(id => nodeById.has(id)).slice(0, 24);
    if (sourceIds.length === 0) return [];
    return [{
      name: 'Library / Module Package',
      category: 'application-architecture',
      confidence: 0.55,
      evidence: [`${sourceIds.length} selected local source nodes`],
      node_ids: sourceIds,
      guidance: 'Treat the selected local files as the architecture boundary; extend nearby modules instead of introducing a parallel structure.',
    }];
  }

  const patterns: NonNullable<NonNullable<CASOutput['architecture_summary']>['architectural_patterns']> = [];
  const idsFor = (...kinds: string[]) => uniqueStrings(kinds.flatMap(kind => byKind.get(kind) || []));
  const countFor = (...kinds: string[]) => idsFor(...kinds).length;
  const add = (
    name: string,
    category: NonNullable<NonNullable<CASOutput['architecture_summary']>['architectural_patterns']>[number]['category'],
    ids: string[],
    guidance: string,
  ) => {
    const uniqueIds = uniqueStrings(ids).slice(0, 40);
    if (uniqueIds.length === 0) return;
    patterns.push({
      name,
      category,
      confidence: Math.min(0.72, 0.5 + uniqueIds.length / 40),
      evidence: [`${uniqueIds.length} selected local ${name.toLowerCase()} owner nodes`],
      node_ids: uniqueIds,
      guidance,
    });
  };

  const presentationIds = idsFor('views', 'view_models');
  const serviceIds = idsFor('services');
  const controllerIds = idsFor('controllers');
  const modelIds = idsFor('models');
  const repositoryIds = idsFor('repositories');
  const clientIds = idsFor('clients');
  const scriptIds = idsFor('scripts');
  const packageIds = idsFor('packages');
  const mediatorIds = idsFor('mediators');
  const unitIds = idsFor('unit_of_work');
  const singletonIds = idsFor('singletons');

  add('Component/Page UI', 'presentation', presentationIds,
    'Place UI changes beside the nearest selected page/component/template owner and preserve local routing, state, and styling conventions.');
  add('Service Layer', 'business-logic', serviceIds,
    'Put orchestration and business rules in the selected service/use-case owners; keep entry points and UI owners thin.');
  add('Repository', 'data-access', repositoryIds,
    'Use the selected repository/store owners for persistence access instead of spreading storage details into callers.');
  add('Client SDK / API Wrapper', 'integration', clientIds,
    'Keep protocol, SDK, and adapter concerns inside the selected client/API wrapper owners.');
  add('Command Script / Automation', 'application-architecture', scriptIds,
    'Preserve the selected script/worker/bot entrypoint and helper-module split.');
  add('Mediator / Handler', 'business-logic', mediatorIds,
    'Route commands, queries, and events through the selected handler or dispatcher style.');
  add('Unit of Work', 'data-access', unitIds,
    'Keep transaction-scoped persistence inside the selected unit-of-work boundary.');
  add('Singleton / Registry', 'object-lifecycle', singletonIds,
    'Reuse the selected registry/configuration lifetime pattern; avoid adding unrelated global state.');

  const layeredIds = idsFor('controllers', 'views', 'services', 'repositories', 'models', 'clients');
  const layerCount = [
    controllerIds.length > 0 || presentationIds.length > 0,
    serviceIds.length > 0 || mediatorIds.length > 0,
    repositoryIds.length > 0 || modelIds.length > 0 || clientIds.length > 0,
  ].filter(Boolean).length;
  if (layerCount >= 2) {
    add('Layered Architecture', 'application-architecture', layeredIds,
      'Preserve local layer direction: entry/presentation owners call service or integration owners, and lower-level owners do not reach back up.');
  }

  const mvcCount = countFor('controllers') + countFor('views') + countFor('models');
  if (controllerIds.length > 0 && presentationIds.length > 0 && modelIds.length > 0 && mvcCount >= 3) {
    add('MVC', 'application-architecture', idsFor('controllers', 'views', 'models'),
      'Keep request handling, data shape, and rendering responsibilities separated across the selected local owners.');
  }

  if (patterns.length === 0 && packageIds.length > 0) {
    add('Library / Module Package', 'application-architecture', packageIds,
      'Treat selected modules/packages as the architecture boundary and extend the nearest existing package instead of creating a parallel structure.');
  }

  return patterns;
}

function synthesizeScopedArchitectureInventory(
  scopedNodeIds: Set<string>,
  nodeById: Map<string, CASNode>,
  files: string[],
  rootPath?: string,
): Record<string, ReturnType<typeof compactArchitectureNode>[]> {
  if (scopedNodeIds.size === 0) return {};

  const grouped = new Map<string, ReturnType<typeof compactArchitectureNode>[]>();
  const add = (kind: string, node: CASNode) => {
    const values = grouped.get(kind) || [];
    if (values.some(item => item.id === node.id)) return;
    values.push(compactArchitectureNode(node, node.id));
    grouped.set(kind, values);
  };

  for (const id of scopedNodeIds) {
    const node = nodeById.get(id);
    if (!node) continue;
    if (!isUsefulArchitectureExampleNode(node)) continue;
    if (!architectureNodeMatchesAnyScopeFile(node, files, rootPath)) continue;
    add(categoryForArchitectureInventoryNode(node), node);
  }

  return Object.fromEntries(Array.from(grouped.entries())
    .map(([kind, nodes]) => [kind, nodes.slice(0, 8)])
    .filter(([, nodes]) => Array.isArray(nodes) && nodes.length > 0));
}

function mergeArchitectureInventory(
  primary: Record<string, ReturnType<typeof compactArchitectureNode>[]>,
  secondary: Record<string, any>,
): Record<string, any[]> {
  const merged = new Map<string, any[]>();
  const addGroup = (inventory: Record<string, any> | undefined) => {
    for (const [kind, nodes] of Object.entries(inventory || {})) {
      if (!Array.isArray(nodes)) continue;
      const values = merged.get(kind) || [];
      for (const node of nodes) {
        const key = String(node?.id || `${node?.name || ''}:${node?.file || ''}`);
        if (values.some(existing => String(existing?.id || `${existing?.name || ''}:${existing?.file || ''}`) === key)) continue;
        values.push(node);
      }
      if (values.length > 0) merged.set(kind, values.slice(0, 8));
    }
  };
  addGroup(primary);
  addGroup(secondary);
  return Object.fromEntries(merged.entries());
}

function categoryForArchitectureInventoryNode(node: CASNode): string {
  const value = `${node.type || ''} ${node.name || ''} ${node.source?.file || ''}`.toLowerCase();
  if (/\b(controller|route|resolver|endpoint)\b/.test(value)) return 'controllers';
  if (/\b(component|page|view|template|screen)\b/.test(value)) return 'views';
  if (/\b(view.?model)\b/.test(value)) return 'view_models';
  if (/\b(repository|repo|dao)\b/.test(value)) return 'repositories';
  if (/\b(entity|model|schema|dto|type)\b/.test(value)) return 'models';
  if (/\b(client|sdk|adapter|gateway)\b/.test(value)) return 'clients';
  if (/\b(handler|command|query|mediator)\b/.test(value)) return 'mediators';
  if (/\b(unit.?of.?work|transaction)\b/.test(value)) return 'unit_of_work';
  if (/\b(singleton|registry)\b/.test(value)) return 'singletons';
  if (/\b(service|manager|orchestrator|processor|dominator|engine)\b/.test(value)) return 'services';
  if (/\b(script|cli|command|job|worker)\b/.test(value)) return 'scripts';
  return 'packages';
}

function isUsefulArchitectureExampleNode(node: CASNode | undefined): node is CASNode {
  if (!node) return false;
  const type = String(node.type || '').toLowerCase();
  if (['import', 'export', 'property', 'variable', 'mock', 'using'].includes(type)) return false;
  const name = String(node.name || '').trim();
  if (/^import\s+/i.test(name) || /^export\s+/i.test(name) || /^using\s+/i.test(name)) return false;
  return true;
}

function architectureTargetTokens(target: string): string[] {
  return uniqueStrings(target
    .split(/[^a-z0-9]+/i)
    .map(token => token.trim().toLowerCase())
    .filter(token => token.length >= 4 && !new Set([
      'with',
      'from',
      'into',
      'this',
      'that',
      'code',
      'file',
      'files',
      'using',
      'imports',
      'pattern',
      'patterns',
      'architecture',
      'inventory',
      'balance',
      'signal',
      'signals',
      'review',
      'modify',
      'change',
      'update',
      'manage',
      'managed',
      'manager',
      'managers',
      'management',
      'analysis',
      'analyzer',
      'usefulness',
      'quality',
      'context',
    ]).has(token)));
}

function architectureNodeMatchesAnyScopeFile(node: any, files: string[], rootPath?: string): boolean {
  const nodeFile = normalizeSourceFile(node?.source?.file || '', rootPath);
  if (!nodeFile) return false;
  return files.some(file => sameArchitectureFileScope(file, nodeFile));
}

function architectureFileScopedNodeIds(
  directNodeIds: Set<string>,
  expandedNodeIds: Set<string>,
  nodeById: Map<string, any>,
  files: string[],
  rootPath?: string,
): Set<string> {
  const scoped = new Set(directNodeIds);
  for (const id of expandedNodeIds) {
    if (scoped.has(id)) continue;
    const nodeFile = normalizeSourceFile(nodeById.get(id)?.source?.file || '', rootPath);
    if (!nodeFile) continue;
    if (files.some(file => sameArchitectureFileScope(file, nodeFile))) scoped.add(id);
  }
  return scoped;
}

function sameArchitectureFileScope(a: string, b: string): boolean {
  const left = normalizeArchitectureScopePath(a).split('/').filter(Boolean);
  const right = normalizeArchitectureScopePath(b).split('/').filter(Boolean);
  if (left.length === 0 || right.length === 0) return false;
  if (sameTrailingArchitecturePath(left, right)) return true;
  if (left[0] !== right[0]) return false;
  const shared = Math.min(left.length, right.length);
  if (left[0] === 'features') return shared >= 3 && left[1] === right[1] && left[2] === right[2];
  if (left[0] === 'defs-api') return shared >= 1;
  if (left[0] === 'assets' && left[1] === 'javascript' && right[1] === 'javascript') return shared >= 3 && left[2] === right[2];
  if (left[0] === 'src') return sameSrcArchitectureScope(left, right, shared);
  if ((left[0] === 'apps' || left[0] === 'packages') && left[2] === 'src' && right[2] === 'src') {
    return shared >= 4 && left[1] === right[1] && left[3] === right[3];
  }
  if (left[0] === 'apps' || left[0] === 'packages') return shared >= 3 && left[1] === right[1] && left[2] === right[2];
  if (left[0] === 'legacy') return shared >= 3 && left[1] === right[1] && left[2] === right[2];
  return shared >= 2 && left[1] === right[1];
}

function normalizeArchitectureScopePath(value: string): string {
  let normalized = normalizeSourceFile(value).toLowerCase().replace(/^\/+/, '');
  normalized = normalized.replace(/(^|\/)src\/app\/features\//, 'features/');
  normalized = normalized.replace(/(^|\/)app\/features\//, 'features/');
  normalized = normalized.replace(/(^|\/)src\/app\/defs-api\//, 'defs-api/');
  normalized = normalized.replace(/(^|\/)app\/defs-api\//, 'defs-api/');
  normalized = normalized.replace(/(^|\/)app\/assets\//, 'assets/');
  normalized = normalized.replace(/(^|\/)app\/javascript\//, 'javascript/');
  normalized = normalized.replace(/(^|\/)vrs_system\/apps\//, 'apps/');
  normalized = normalized.replace(/(^|\/)modules\//, 'modules/');
  for (const marker of ['packages', 'apps', 'legacy', 'src', 'features', 'defs-api', 'modules', 'components', 'core', 'assets', 'javascript']) {
    const index = normalized.indexOf(`${marker}/`);
    if (index > 0) {
      normalized = normalized.slice(index);
      break;
    }
  }
  if (normalized.startsWith('modules/')) normalized = normalized.slice('modules/'.length);
  return normalized;
}

function sameSrcArchitectureScope(left: string[], right: string[], shared: number): boolean {
  if (left[1] !== right[1]) return false;
  const featureScopedBuckets = new Set([
    'business',
    'components',
    'controllers',
    'features',
    'modules',
    'pages',
    'routes',
    'services',
    'stores',
  ]);
  if (!featureScopedBuckets.has(left[1])) return shared >= 2;
  if (shared < 3 || left[2] !== right[2]) return false;
  if (left[1] === 'services' && /^(?:adapter|adapters|external|external-sources|integrations?)$/.test(left[2])) {
    return shared >= 4 && left[3] === right[3];
  }
  return true;
}

function sameTrailingArchitecturePath(left: string[], right: string[]): boolean {
  const shared = Math.min(left.length, right.length);
  if (shared === 1) return left[left.length - 1] === right[right.length - 1];
  if (shared < 2) return false;
  return left[left.length - 1] === right[right.length - 1] &&
    left[left.length - 2] === right[right.length - 2];
}

function expandRelevantArchitectureNodeIds(relevantNodeIds: Set<string>, cas: CASOutput): void {
  if (relevantNodeIds.size === 0) return;
  for (const edge of cas.edges || []) {
    if (relevantNodeIds.has(edge.source)) relevantNodeIds.add(edge.target);
    if (relevantNodeIds.has(edge.target)) relevantNodeIds.add(edge.source);
  }
}

function patternUseWhen(patternName: string, category = ''): string {
  const value = `${patternName} ${category}`.toLowerCase();
  if (/mvc/.test(value)) return 'Use for request/page flows that already separate controllers, models, and views/components.';
  if (/mvvm|view.?model/.test(value)) return 'Use for UI state/interaction behavior where views bind to view-model owners.';
  if (/component|page|ui|presentation|template/.test(value)) return 'Use for page, component, layout, styling, and interaction changes; place behavior beside the closest local UI owner.';
  if (/repository|data/.test(value)) return 'Use for persistence access and query boundaries; keep callers out of raw storage details.';
  if (/unit.?of.?work|transaction/.test(value)) return 'Use when a change coordinates multiple repository writes or transaction-scoped persistence.';
  if (/command script|automation|script/.test(value)) return 'Use for command-line or build automation behavior; preserve the entry script and helper-module split.';
  if (/mediator|handler|command|query/.test(value)) return 'Use when the codebase routes use-cases through command/query handlers or mediator dispatch.';
  if (/client|sdk|api wrapper|adapter/.test(value)) return 'Use for remote API/client integration boundaries; keep protocol and adapter details in client owners.';
  if (/static|asset|theme|pipeline/.test(value)) return 'Use for content, styling, theme, or asset behavior; preserve asset/template placement and build conventions.';
  if (/service|business/.test(value)) return 'Use for business rules and orchestration behind thin entry points.';
  if (/singleton|registry/.test(value)) return 'Use only for established registry/configuration lifetimes; avoid adding global state casually.';
  return 'Use only when the requested behavior matches the local examples and owner categories.';
}

function ownerCategoriesForPattern(
  patternName: string,
  category = '',
  _inventory?: NonNullable<CASOutput['architecture_summary']>['architectural_inventory']
): string[] {
  const value = `${patternName} ${category}`.toLowerCase();
  const categories: string[] = [];
  const add = (kind: string) => {
    categories.push(kind);
  };

  if (/mvc/.test(value)) {
    add('controllers');
    add('models');
    add('views');
  }
  if (/mvvm|view.?model/.test(value)) {
    add('views');
    add('view_models');
    add('models');
  }
  if (/component|page|ui|presentation|template/.test(value)) {
    add('views');
    add('packages');
    add('clients');
  }
  if (/repository|data/.test(value)) add('repositories');
  if (/unit.?of.?work|transaction/.test(value)) add('unit_of_work');
  if (/command script|automation|script/.test(value)) add('scripts');
  if (/mediator|handler|command|query/.test(value)) add('mediators');
  if (/client|sdk|api wrapper|adapter/.test(value)) add('clients');
  if (/static|asset|theme|pipeline/.test(value)) {
    add('clients');
    add('views');
    add('scripts');
  }
  if (/service|business/.test(value)) add('services');
  if (/singleton|registry/.test(value)) add('singletons');
  if (/library|module|package/.test(value)) add('packages');
  if (/layer/.test(value)) {
    add('controllers');
    add('services');
    add('repositories');
    add('clients');
  }
  if (/feature/.test(value)) {
    add('packages');
    add('services');
    add('controllers');
    add('views');
  }

  return uniqueStrings(categories);
}

function adaptWorkPacketForRepoScale<T extends Record<string, any>>(packet: T, cas: CASOutput): T {
  const profile = workPacketScaleProfile(cas, packet);
  if (profile === 'standard') return packet;
  if (profile === 'small-repo-minimal') return compactSmallRepoMinimalWorkPacket(packet);
  if (profile === 'token-minimal') return compactTokenMinimalWorkPacket(packet);
  if (profile === 'tiny') return compactTinyWorkPacket(packet);

  return {
    ...packet,
    packet_profile: 'micro-repo',
    work_context: compactMicroWorkContext(packet.work_context),
    file_read_plan: compactMicroFileReadPlan(packet.file_read_plan),
    invariant_impact: compactMicroInvariantImpact(packet.invariant_impact),
    validation_plan: compactMicroValidationPlan(packet.validation_plan),
    next_mcp_calls: compactMicroToolPlan(packet.next_mcp_calls),
    source_reading_rule: 'This is a small repository. Use the file_read_plan first, then read whole files only when the listed line windows are insufficient. Keep idiom and invariant checks lightweight but still run them before finalizing edits.',
  } as unknown as T;
}

function compactSmallRepoMinimalWorkPacket<T extends Record<string, any>>(packet: T): T {
  const context = packet.work_context || {};
  const task = compactPacketTask(packet.task);
  return {
    path: packet.path,
    generated_at: packet.generated_at,
    task,
    status: packet.status,
    default_use: packet.default_use,
    packet_profile: 'small-repo-minimal',
    ...(packet.sensitive_data_exposure ? { sensitive_data_exposure: packet.sensitive_data_exposure } : {}),
    ...(packet.analysis_freshness ? { analysis_freshness: packet.analysis_freshness } : {}),
    selected_node: packet.selected_node,
    work_context: {
      coding_context: compactCodingContextForMicroRepo(context.coding_context),
      architecture_context: compactSmallRepoArchitectureContext(context.architecture_context),
      risk: compactRiskForMicroRepo(context.risk),
      risk_context: compactMinimalRiskContext(context.risk_context),
      tests: compactMinimalTests(context.tests),
      behavioral_invariants: compactMinimalInvariants(context.behavioral_invariants),
      idiom_context: compactMinimalIdioms(context.idiom_context),
      capability_memory: compactSmallRepoCapabilityMemory(context.capability_memory),
      ...compactPillarWorkContext(context, { journeys: 2, entities: 2, deviations: 2 }),
    },
    file_read_plan: compactMinimalFileReadPlan(packet.file_read_plan).slice(0, 3),
    validation_plan: compactMinimalValidationPlan(packet.validation_plan),
    next_mcp_calls: compactMinimalToolPlan(packet.next_mcp_calls, task).slice(0, 2),
    source_reading_rule: 'Small repo: read the listed files first, preserve idioms, avoid duplicate capability work, then validate.',
    gaps: Array.isArray(packet.gaps) ? packet.gaps.slice(0, 2) : packet.gaps,
  } as unknown as T;
}

function compactTinyWorkPacket<T extends Record<string, any>>(packet: T): T {
  const selected = packet.selected_node;
  const context = packet.work_context || {};
  const idioms = compactIdiomContextForMicroRepo(context.idiom_context);
  const invariants = compactInvariantsForMicroRepo(context.behavioral_invariants);
  return {
    path: packet.path,
    generated_at: packet.generated_at,
    task: packet.task,
    status: packet.status,
    default_use: packet.default_use,
    packet_profile: 'ultra-small-repo',
    ...(packet.sensitive_data_exposure ? { sensitive_data_exposure: packet.sensitive_data_exposure } : {}),
    ...(packet.analysis_freshness ? { analysis_freshness: packet.analysis_freshness } : {}),
    readiness: {
      status: packet.readiness?.status,
      score: packet.readiness?.score,
      profile: packet.readiness?.profile,
      gaps: Array.isArray(packet.readiness?.gaps) ? packet.readiness.gaps.slice(0, 3) : packet.readiness?.gaps,
    },
    target_resolution: {
      query: packet.target_resolution?.query,
      selected_node_id: packet.target_resolution?.selected_node_id,
      selected_node: packet.target_resolution?.selected_node,
      gaps: Array.isArray(packet.target_resolution?.gaps) ? packet.target_resolution.gaps.slice(0, 3) : packet.target_resolution?.gaps,
    },
    selected_node: selected,
    work_context: {
      coding_context: compactCodingContextForMicroRepo(context.coding_context),
      architecture_context: compactArchitectureContextForMicroRepo(context.architecture_context),
      risk: compactRiskForMicroRepo(context.risk),
      risk_context: compactRiskContextForMicroRepo(context.risk_context),
      tests: compactTestsForMicroRepo(context.tests),
      idiom_context: idioms ? {
        total_idioms: idioms.total_idioms,
        selected_idioms: Array.isArray(idioms.selected_idioms) ? idioms.selected_idioms.slice(0, 2) : idioms.selected_idioms,
        do: Array.isArray(idioms.do) ? idioms.do.slice(0, 3) : idioms.do,
        avoid: Array.isArray(idioms.avoid) ? idioms.avoid.slice(0, 3) : idioms.avoid,
      } : null,
      system_health: compactSystemHealthForAgent(context.system_health),
      capability_memory: compactCapabilityMemoryForMicroRepo(context.capability_memory),
      behavioral_invariants: invariants ? {
        total: invariants.total,
        invariants: Array.isArray(invariants.invariants) ? invariants.invariants.slice(0, 2) : invariants.invariants,
      } : null,
      ...compactPillarWorkContext(context, { journeys: 2, entities: 2, deviations: 2 }),
    },
    file_read_plan: compactMicroFileReadPlan(packet.file_read_plan).slice(0, 5),
    validation_plan: {
      strategy: packet.validation_plan?.strategy,
      commands: Array.isArray(packet.validation_plan?.commands) ? packet.validation_plan.commands.slice(0, 2) : packet.validation_plan?.commands,
      manual_checks: Array.isArray(packet.validation_plan?.manual_checks) ? packet.validation_plan.manual_checks.slice(0, 4) : packet.validation_plan?.manual_checks,
      gaps: Array.isArray(packet.validation_plan?.gaps) ? packet.validation_plan.gaps.slice(0, 2) : packet.validation_plan?.gaps,
    },
    next_mcp_calls: compactMicroToolPlan(packet.next_mcp_calls).slice(0, 4),
    source_reading_rule: 'This repo is small enough that Klauro should narrow the first read, then the agent may read the listed files fully if needed. Preserve the listed idioms and invariants before finalizing.',
    gaps: Array.isArray(packet.gaps) ? packet.gaps.slice(0, 4) : packet.gaps,
  } as unknown as T;
}

function compactTokenMinimalWorkPacket<T extends Record<string, any>>(packet: T): T {
  const context = packet.work_context || {};
  const task = compactPacketTask(packet.task);
  const fileReadPlan = compactMinimalFileReadPlan(packet.file_read_plan);
  const architectureContext = filterArchitectureContextToFilePlan(
    compactMinimalArchitectureContext(context.architecture_context),
    fileReadPlan,
  );
  return {
    path: packet.path,
    generated_at: packet.generated_at,
    task,
    status: packet.status,
    default_use: packet.default_use,
    packet_profile: 'token-minimal',
    ...(packet.sensitive_data_exposure ? { sensitive_data_exposure: packet.sensitive_data_exposure } : {}),
    ...(packet.analysis_freshness ? { analysis_freshness: packet.analysis_freshness } : {}),
    readiness: {
      status: packet.readiness?.status,
      score: packet.readiness?.score,
      gaps: Array.isArray(packet.readiness?.gaps) ? packet.readiness.gaps.slice(0, 2) : packet.readiness?.gaps,
    },
    target_resolution: {
      query: packet.target_resolution?.query,
      selected_node_id: packet.target_resolution?.selected_node_id,
      selected_node: packet.target_resolution?.selected_node,
      gaps: Array.isArray(packet.target_resolution?.gaps) ? packet.target_resolution.gaps.slice(0, 2) : packet.target_resolution?.gaps,
    },
    selected_node: packet.selected_node,
    work_context: {
      architecture_context: architectureContext,
      risk: compactMinimalRisk(context.risk),
      risk_context: compactMinimalRiskContext(context.risk_context),
      tests: compactMinimalTests(context.tests),
      behavioral_invariants: compactMinimalInvariants(context.behavioral_invariants),
      idiom_context: compactMinimalIdioms(context.idiom_context),
      system_health: compactMinimalSystemHealth(context.system_health),
      capability_memory: compactMinimalCapabilityMemory(context.capability_memory),
      ...compactPillarWorkContext(context, { journeys: 2, entities: 2, deviations: 2 }),
    },
    file_read_plan: fileReadPlan,
    validation_plan: compactMinimalValidationPlan(packet.validation_plan),
    next_mcp_calls: compactMinimalToolPlan(packet.next_mcp_calls, task),
    source_reading_rule: 'Token-minimal packet: read only these line windows first. Expand with the listed MCP calls only when the edit proves the local context is insufficient.',
    gaps: Array.isArray(packet.gaps) ? packet.gaps.slice(0, 3) : packet.gaps,
  } as unknown as T;
}

function workPacketScaleProfile(cas: CASOutput, packet?: Record<string, any>): 'small-repo-minimal' | 'token-minimal' | 'tiny' | 'micro' | 'standard' {
  const forcedProfile = process.env.KLAURO_AGENT_PACKET_PROFILE;
  if (forcedProfile === 'standard' || forcedProfile === 'micro' || forcedProfile === 'tiny' || forcedProfile === 'token-minimal' || forcedProfile === 'small-repo-minimal') {
    return forcedProfile;
  }
  const sourceFiles = uniqueStrings((cas.nodes || [])
    .map(node => node.source?.file || '')
    .filter(file => Boolean(file) && !isNonProductSourceText(file)));
  const productNodes = (cas.nodes || []).filter(node => !node.metadata?.is_test && !node.metadata?.is_generated && !isNonProductAgentTarget(node));
  const sourceTokens = estimateCasSourceTokens(cas, sourceFiles);
  const filePlanCount = Array.isArray(packet?.file_read_plan) ? packet.file_read_plan.length : undefined;
  const selectedType = String(packet?.selected_node?.type || '').toLowerCase();
  const targetText = [
    packet?.task?.target,
    packet?.task?.instructions,
  ].filter(Boolean).join(' ');
  const explicitTarget = Boolean(packet?.task?.target || /inspect\s+\S+\.\w+|preserve connected behavior/i.test(targetText));
  const narrowTarget = Boolean(explicitTarget && ['file', 'module', 'function', 'method', 'variable', 'class', 'handler', 'route', 'api_route'].includes(selectedType));
  if (sourceTokens > 0 && sourceTokens <= 40000) return 'small-repo-minimal';
  if (narrowTarget && productNodes.length <= 220) return 'small-repo-minimal';
  if (narrowTarget || (sourceTokens > 0 && sourceTokens <= 60000)) return 'token-minimal';
  if (sourceFiles.length <= 18 || productNodes.length <= 160) return 'micro';
  return 'token-minimal';
}

function compactSmallRepoArchitectureContext(context: any) {
  if (!context || typeof context !== 'object') return context || null;
  return {
    system_type: context.system_type,
    architecture_budget: Array.isArray(context.architecture_budget) ? context.architecture_budget.slice(0, 2) : [],
    patterns: Array.isArray(context.patterns) ? context.patterns.slice(0, 3).map((pattern: any) => ({
      name: pattern.name,
      confidence: pattern.confidence,
    })) : [],
    inventory_counts: compactNonZeroCounts(context.inventory_counts, 6),
    inventory_examples: compactSmallArchitectureInventory(context.inventory_examples, 1),
    relevant_inventory: compactSmallArchitectureInventory(context.relevant_inventory, 1),
    pattern_decision_matrix: Array.isArray(context.pattern_decision_matrix) ? context.pattern_decision_matrix.slice(0, 3).map((item: any) => ({
      pattern: item.pattern,
      use_when: item.use_when,
      owner_categories: Array.isArray(item.owner_categories) ? item.owner_categories.slice(0, 3) : item.owner_categories,
    })) : [],
    pattern_balance: context.pattern_balance ? {
      status: context.pattern_balance.status,
      risks: Array.isArray(context.pattern_balance.risks) ? context.pattern_balance.risks.slice(0, 1) : [],
    } : null,
    agent_rules: Array.isArray(context.agent_rules) ? context.agent_rules.slice(0, 2) : [],
  };
}

function compactMinimalRisk(risk: any) {
  if (!risk || typeof risk !== 'object') return risk || null;
  return {
    ...(risk.target_file_changed_since_analysis ? { target_file_changed_since_analysis: risk.target_file_changed_since_analysis } : {}),
    risk_level: risk.risk?.risk_level || risk.risk_level || null,
    factors: Array.isArray(risk.risk?.risk_factors) ? risk.risk.risk_factors.slice(0, 2) : [],
    recommendations: Array.isArray(risk.risk?.recommendations) ? risk.risk.recommendations.slice(0, 2) : [],
    summary: risk.change_risk_summary ? {
      high: risk.change_risk_summary.total_high_risk_nodes,
      medium: risk.change_risk_summary.total_medium_risk_nodes,
      top_factors: Array.isArray(risk.change_risk_summary.top_risk_factors)
        ? risk.change_risk_summary.top_risk_factors.slice(0, 2)
        : [],
    } : null,
  };
}

function compactMinimalArchitectureContext(context: any) {
  if (!context || typeof context !== 'object') return context || null;
  return {
    system_type: context.system_type,
    architecture_budget: Array.isArray(context.architecture_budget) ? context.architecture_budget.slice(0, 4) : [],
    patterns: Array.isArray(context.patterns) ? context.patterns.slice(0, 4).map((pattern: any) => ({
      name: pattern.name,
      confidence: pattern.confidence,
      guidance: pattern.guidance,
    })) : [],
    inventory_counts: context.inventory_counts || {},
    inventory_examples: compactSmallArchitectureInventory(context.inventory_examples, 2),
    relevant_inventory: compactSmallArchitectureInventory(context.relevant_inventory, 2),
    pattern_decision_matrix: Array.isArray(context.pattern_decision_matrix) ? context.pattern_decision_matrix.slice(0, 4).map((item: any) => ({
      pattern: item.pattern,
      use_when: item.use_when,
      owner_categories: Array.isArray(item.owner_categories) ? item.owner_categories.slice(0, 4) : item.owner_categories,
      examples: Array.isArray(item.examples) ? item.examples.slice(0, 2).map((node: any) => ({
        name: node?.name || node?.id,
        type: node?.type,
        file: compactArchitectureFile(node?.file),
      })).filter((node: any) => node.name || node.file) : item.examples,
    })) : [],
    pattern_balance: context.pattern_balance ? {
      status: context.pattern_balance.status,
      risks: Array.isArray(context.pattern_balance.risks) ? context.pattern_balance.risks.slice(0, 2) : [],
    } : null,
    agent_rules: Array.isArray(context.agent_rules) ? context.agent_rules.slice(0, 3) : [],
  };
}

function filterArchitectureContextToFilePlan(context: any, fileReadPlan: any[]): any {
  if (!context || typeof context !== 'object') return context || null;
  const files = Array.isArray(fileReadPlan)
    ? fileReadPlan.map(item => String(item?.file || '')).filter(Boolean)
    : [];
  if (files.length === 0) return context;
  const nodeMatchesPlan = (node: any) => {
    const file = String(node?.file || '').trim();
    return !file || files.some(planFile => sameArchitectureFileScope(planFile, file));
  };
  const filterInventory = (inventory: any) => {
    if (!inventory || typeof inventory !== 'object') return {};
    return Object.fromEntries(Object.entries(inventory)
      .map(([kind, nodes]) => [
        kind,
        Array.isArray(nodes) ? nodes.filter(nodeMatchesPlan) : nodes,
      ])
      .filter(([, nodes]) => Array.isArray(nodes) ? nodes.length > 0 : Boolean(nodes)));
  };

  return {
    ...context,
    inventory_examples: filterInventory(context.inventory_examples),
    relevant_inventory: filterInventory(context.relevant_inventory),
    pattern_decision_matrix: Array.isArray(context.pattern_decision_matrix)
      ? context.pattern_decision_matrix.map((row: any) => ({
        ...row,
        examples: Array.isArray(row.examples) ? row.examples.filter(nodeMatchesPlan) : row.examples,
      }))
      : context.pattern_decision_matrix,
  };
}

function compactMinimalTests(tests: any) {
  if (!tests || typeof tests !== 'object') return tests || null;
  return {
    total_suites: tests.total_suites,
    suites: Array.isArray(tests.suites) ? tests.suites.slice(0, 2).map((suite: any) => ({
      file_path: suite.file_path,
      name: suite.name,
      test_count: suite.test_count,
    })) : [],
    recommendation: tests.recommendation,
  };
}

function compactMinimalInvariants(invariants: any) {
  if (!invariants || typeof invariants !== 'object') return invariants || null;
  return {
    total: invariants.total,
    invariants: Array.isArray(invariants.invariants) ? invariants.invariants.slice(0, 2).map((invariant: any) => ({
      name: invariant.name,
      type: invariant.invariant_type,
      checks: Array.isArray(invariant.required_checks) ? invariant.required_checks.slice(0, 2) : undefined,
    })) : [],
  };
}

function compactMinimalIdioms(idioms: any) {
  if (!idioms || typeof idioms !== 'object') return idioms || null;
  return {
    total_idioms: idioms.total_idioms,
    selected: Array.isArray(idioms.selected_idioms) ? idioms.selected_idioms.slice(0, 1).map((idiom: any) => ({
      category: idiom.category,
      name: idiom.name,
    })) : [],
    do: Array.isArray(idioms.do) ? idioms.do.slice(0, 2) : [],
    avoid: Array.isArray(idioms.avoid) ? idioms.avoid.slice(0, 2) : [],
  };
}

function compactMinimalSystemHealth(health: any) {
  if (!health || typeof health !== 'object') return health || null;
  return {
    score: health.score,
    status: health.status,
    coherence: health.coherence?.status,
    risks: Array.isArray(health.top_risks) ? health.top_risks.slice(0, 2).map((risk: any) => ({
      type: risk.type,
      severity: risk.severity,
      title: risk.title,
    })) : [],
    agent_rules: Array.isArray(health.remediation?.agent_rules) ? health.remediation.agent_rules.slice(0, 2) : [],
  };
}

function compactMinimalCapabilityMemory(memory: any) {
  if (!memory || typeof memory !== 'object') return memory || null;
  return {
    status: memory.status,
    matched_capabilities: Array.isArray(memory.matched_capabilities) ? memory.matched_capabilities.slice(0, 2).map((capability: any) => ({
      name: capability.name,
      score: capability.score,
      paths: Array.isArray(capability.operation_paths) ? capability.operation_paths.slice(0, 2) : [],
    })) : [],
    decisions: Array.isArray(memory.reuse_decisions_required) ? memory.reuse_decisions_required.slice(0, 2).map((decision: any) => ({
      existing_capability: decision.existing_capability,
      decision_required: Array.isArray(decision.decision_required) ? decision.decision_required.slice(0, 2) : decision.decision_required,
    })) : [],
  };
}

function compactSmallRepoCapabilityMemory(memory: any) {
  if (!memory || typeof memory !== 'object') return memory || null;
  return {
    status: memory.status,
    matched: Array.isArray(memory.matched_capabilities) ? memory.matched_capabilities.slice(0, 1).map((capability: any) => ({
      name: capability.name,
      paths: Array.isArray(capability.operation_paths) ? capability.operation_paths.slice(0, 1) : [],
    })) : [],
    decision: Array.isArray(memory.reuse_decisions_required) && memory.reuse_decisions_required[0]
      ? {
          existing_capability: memory.reuse_decisions_required[0].existing_capability,
          decision_required: Array.isArray(memory.reuse_decisions_required[0].decision_required)
            ? memory.reuse_decisions_required[0].decision_required.slice(0, 1)
            : memory.reuse_decisions_required[0].decision_required,
        }
      : null,
  };
}

function compactMinimalFileReadPlan(plan: any) {
  if (!Array.isArray(plan)) return [];
  return plan.slice(0, 5).map((item: any) => {
    const lineWindow = compactLineWindow(item.line_window, item.line);
    return {
      file: item.file,
      reason: item.reason,
      line: item.line,
      line_window: lineWindow,
    };
  });
}

function compactLineWindow(lineWindow: any, line?: number) {
  const center = Number(line || lineWindow?.start || 1);
  const start = Math.max(1, center - 12);
  const end = Math.max(start + 24, Math.min(Number(lineWindow?.end || center + 36), start + 48));
  return {
    start,
    end,
    instruction: `Read ${start}-${end}; expand only if needed.`,
  };
}

function compactMinimalValidationPlan(plan: any) {
  if (!plan || typeof plan !== 'object') return plan || null;
  return {
    strategy: plan.strategy,
    commands: Array.isArray(plan.commands) ? plan.commands.slice(0, 1) : [],
    manual_checks: compactManualChecks(plan.manual_checks, 3),
    gaps: Array.isArray(plan.gaps) ? plan.gaps.slice(0, 2) : [],
  };
}

function compactMinimalToolPlan(steps: any, task?: any) {
  if (!Array.isArray(steps)) return [];
  return steps
    .filter(step => step.required)
    .slice(0, 3)
    .map(step => ({
      order: step.order,
      tool: step.tool,
      args: compactToolArgs(step.args, task),
      required: step.required,
    }));
}

function compactPacketTask(task: any) {
  if (!task || typeof task !== 'object') return task;
  return {
    task_type: task.task_type,
    target: task.target,
    instructions: task.instructions,
  };
}

function compactToolArgs(args: any, task?: any) {
  if (!args || typeof args !== 'object') return args;
  const compact: Record<string, unknown> = {};
  if (args.path) compact.path = args.path;
  if (args.task || task) compact.task = compactPacketTask(args.task || task);
  if (args.target) compact.target = args.target;
  if (args.node_id) compact.node_id = args.node_id;
  if (args.files) compact.files = Array.isArray(args.files) ? args.files.slice(0, 3) : args.files;
  if (args.changed_files) compact.changed_files = Array.isArray(args.changed_files) ? args.changed_files.slice(0, 3) : args.changed_files;
  return compact;
}

function compactManualChecks(checks: any, limit: number): string[] {
  if (!Array.isArray(checks)) return [];
  const compacted = checks.slice(0, limit).map(check => {
    const text = String(check || '');
    if (/validate_behavioral_invariants/i.test(text)) return 'Run validate_behavioral_invariants after edits.';
    if (/validate_codebase_idioms/i.test(text)) return 'Run validate_codebase_idioms after edits.';
    return text.replace(/\s+/g, ' ').replace(/ for [A-Za-z0-9_./:-]+\.?$/, '.');
  });
  return uniqueStrings(compacted);
}

function estimateCasSourceTokens(cas: CASOutput, sourceFiles: string[]): number {
  const rootPath = cas.system?.root_path;
  if (!rootPath) return 0;
  let bytes = 0;
  for (const file of sourceFiles.slice(0, 2000)) {
    const absolute = nodePath.isAbsolute(file) ? file : nodePath.join(rootPath, file);
    try {
      if (!fs.existsSync(absolute)) continue;
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size > 1_000_000) continue;
      bytes += stat.size;
      if (bytes > 1_200_000) break;
    } catch {
      continue;
    }
  }
  return Math.ceil(bytes / 4);
}

function compactMicroWorkContext(context: any) {
  if (!context || typeof context !== 'object') return context || null;
  return {
    coding_context: compactCodingContextForMicroRepo(context.coding_context),
    architecture_context: compactArchitectureContextForMicroRepo(context.architecture_context),
    risk: compactRiskForMicroRepo(context.risk),
    risk_context: compactRiskContextForMicroRepo(context.risk_context),
    tests: compactTestsForMicroRepo(context.tests),
    behavioral_invariants: compactInvariantsForMicroRepo(context.behavioral_invariants),
    idiom_context: compactIdiomContextForMicroRepo(context.idiom_context),
    system_health: compactSystemHealthForAgent(context.system_health),
    capability_memory: compactCapabilityMemoryForMicroRepo(context.capability_memory),
    entry_context: compactEntryContextForMicroRepo(context.entry_context),
    ...compactPillarWorkContext(context, { journeys: 3, entities: 3, deviations: 3 }),
  };
}

function compactArchitectureContextForMicroRepo(context: any) {
  if (!context || typeof context !== 'object') return context || null;
  return {
    system_type: context.system_type,
    architecture_budget: Array.isArray(context.architecture_budget) ? context.architecture_budget.slice(0, 5) : context.architecture_budget,
    patterns: Array.isArray(context.patterns) ? context.patterns.slice(0, 5) : context.patterns,
    inventory_counts: context.inventory_counts,
    inventory_examples: compactRelevantArchitectureInventory(context.inventory_examples, 4),
    relevant_inventory: compactRelevantArchitectureInventory(context.relevant_inventory, 5),
    pattern_decision_matrix: Array.isArray(context.pattern_decision_matrix) ? context.pattern_decision_matrix.slice(0, 5) : context.pattern_decision_matrix,
    pattern_balance: context.pattern_balance,
    agent_rules: Array.isArray(context.agent_rules) ? context.agent_rules.slice(0, 5) : context.agent_rules,
  };
}

function compactCodingContextForMicroRepo(context: any) {
  if (!context || typeof context !== 'object') return context || null;
  const checklist = context.checklist ?? context.modification_checklist;
  const relatedFiles = context.related_files ?? context.connected_code;
  return {
    target: context.target ?? context.target_node,
    summary: context.summary,
    conventions: Array.isArray(context.conventions) ? context.conventions.slice(0, 4) : context.conventions,
    related_files: Array.isArray(relatedFiles) ? relatedFiles.slice(0, 5) : relatedFiles,
    checklist: Array.isArray(checklist) ? checklist.slice(0, 5) : checklist,
  };
}

function compactRiskForMicroRepo(risk: any) {
  if (!risk || typeof risk !== 'object') return risk || null;
  const summary = risk.change_risk_summary;
  return {
    ...(risk.target_file_changed_since_analysis ? { target_file_changed_since_analysis: risk.target_file_changed_since_analysis } : {}),
    risk: risk.risk ? {
      risk_level: risk.risk.risk_level,
      risk_factors: Array.isArray(risk.risk.risk_factors) ? risk.risk.risk_factors.slice(0, 3) : risk.risk.risk_factors,
      recommendations: Array.isArray(risk.risk.recommendations) ? risk.risk.recommendations.slice(0, 3) : risk.risk.recommendations,
    } : null,
    change_risk_summary: summary && typeof summary === 'object' ? {
      total_high_risk_nodes: summary.total_high_risk_nodes,
      total_medium_risk_nodes: summary.total_medium_risk_nodes,
      top_high_risk_nodes: Array.isArray(summary.top_high_risk_nodes) ? summary.top_high_risk_nodes.slice(0, 3) : summary.top_high_risk_nodes,
      top_risk_factors: Array.isArray(summary.top_risk_factors) ? summary.top_risk_factors.slice(0, 4) : summary.top_risk_factors,
    } : summary || null,
  };
}

function compactTestsForMicroRepo(tests: any) {
  if (!tests || typeof tests !== 'object') return tests || null;
  return {
    total_suites: tests.total_suites,
    total_mocks: tests.total_mocks,
    total_fixtures: tests.total_fixtures,
    suites: Array.isArray(tests.suites) ? tests.suites.slice(0, 3).map((suite: any) => ({
      name: suite.name,
      file_path: suite.file_path,
      test_type: suite.test_type,
      framework: suite.framework,
      test_count: suite.test_count,
    })) : tests.suites,
    recommendation: tests.recommendation,
  };
}

function compactInvariantsForMicroRepo(invariants: any) {
  if (!invariants || typeof invariants !== 'object') return invariants || null;
  return {
    total: invariants.total,
    summary: invariants.summary,
    invariants: Array.isArray(invariants.invariants) ? invariants.invariants.slice(0, 4).map((invariant: any) => ({
      id: invariant.id,
      name: invariant.name,
      invariant_type: invariant.invariant_type,
      confidence: invariant.confidence,
      enforcement_summary: invariant.enforcement_summary,
      related_tests: Array.isArray(invariant.related_tests) ? invariant.related_tests.slice(0, 3) : invariant.related_tests,
      gaps: Array.isArray(invariant.gaps) ? invariant.gaps.slice(0, 3) : invariant.gaps,
    })) : invariants.invariants,
    recommendation: invariants.recommendation,
  };
}

function compactIdiomContextForMicroRepo(idioms: any) {
  if (!idioms || typeof idioms !== 'object') return idioms || null;
  return {
    total_idioms: idioms.total_idioms,
    selected_idioms: Array.isArray(idioms.selected_idioms) ? idioms.selected_idioms.slice(0, 4).map((idiom: any) => ({
      id: idiom.id,
      category: idiom.category,
      name: idiom.name,
      confidence: idiom.confidence,
      do: Array.isArray(idiom.do) ? idiom.do.slice(0, 2) : idiom.do,
      avoid: Array.isArray(idiom.avoid) ? idiom.avoid.slice(0, 2) : idiom.avoid,
    })) : idioms.selected_idioms,
    local_examples: Array.isArray(idioms.local_examples) ? idioms.local_examples.slice(0, 4) : idioms.local_examples,
    do: Array.isArray(idioms.do) ? idioms.do.slice(0, 6) : idioms.do,
    avoid: Array.isArray(idioms.avoid) ? idioms.avoid.slice(0, 6) : idioms.avoid,
    validation: Array.isArray(idioms.validation) ? idioms.validation.slice(0, 5) : idioms.validation,
  };
}

function compactCapabilityMemoryForMicroRepo(memory: any) {
  if (!memory || typeof memory !== 'object') return memory || null;
  return {
    status: memory.status,
    task_signal: memory.task_signal,
    matched_capabilities: Array.isArray(memory.matched_capabilities)
      ? memory.matched_capabilities.slice(0, 4).map((capability: any) => ({
        id: capability.id,
        name: capability.name,
        score: capability.score,
        category: capability.category,
        criticality: capability.criticality,
        matched_terms: Array.isArray(capability.matched_terms) ? capability.matched_terms.slice(0, 6) : capability.matched_terms,
        operation_paths: Array.isArray(capability.operation_paths) ? capability.operation_paths.slice(0, 4) : capability.operation_paths,
        related_entities: Array.isArray(capability.related_entities) ? capability.related_entities.slice(0, 4) : capability.related_entities,
      }))
      : memory.matched_capabilities,
    reuse_decisions_required: Array.isArray(memory.reuse_decisions_required)
      ? memory.reuse_decisions_required.slice(0, 4)
      : memory.reuse_decisions_required,
    agent_guidance: Array.isArray(memory.agent_guidance)
      ? memory.agent_guidance.slice(0, 5)
      : memory.agent_guidance,
  };
}

function compactEntryContextForMicroRepo(entry: any) {
  if (!entry || typeof entry !== 'object') return entry || null;
  return {
    task_type: entry.task_type,
    representative_entry_point: entry.representative_entry_point,
    related_entry_points: Array.isArray(entry.related_entry_points) ? entry.related_entry_points.slice(0, 3) : entry.related_entry_points,
  };
}

function compactRelevantArchitectureInventory(inventory: any, perKindLimit: number) {
  if (!inventory || typeof inventory !== 'object') return {};
  return Object.fromEntries(Object.entries(inventory)
    .map(([kind, nodes]) => [
      kind,
      Array.isArray(nodes) ? nodes.slice(0, perKindLimit) : nodes,
    ])
    .filter(([, nodes]) => Array.isArray(nodes) ? nodes.length > 0 : Boolean(nodes)));
}

function compactSmallArchitectureInventory(inventory: any, perKindLimit: number) {
  if (!inventory || typeof inventory !== 'object') return {};
  return Object.fromEntries(Object.entries(inventory)
    .map(([kind, nodes]) => [
      kind,
      Array.isArray(nodes)
        ? nodes.slice(0, perKindLimit).map((node: any) => ({
            name: node?.name || node?.id,
            type: node?.type,
            file: compactArchitectureFile(node?.file),
          })).filter((node: any) => node.name || node.file)
        : nodes,
    ])
    .filter(([, nodes]) => Array.isArray(nodes) ? nodes.length > 0 : Boolean(nodes)));
}

function compactNonZeroCounts(counts: any, limit: number) {
  if (!counts || typeof counts !== 'object') return {};
  return Object.fromEntries(Object.entries(counts)
    .filter(([, value]) => Number(value || 0) > 0)
    .slice(0, limit));
}

function compactArchitectureFile(file: any): string | undefined {
  const value = String(file || '').replace(/\\/g, '/');
  if (!value) return undefined;
  const srcIndex = value.lastIndexOf('/src/');
  if (srcIndex >= 0) return value.slice(srcIndex + 1);
  return value.split('/').slice(-3).join('/');
}

function compactArchitectureNode(node: CASNode | undefined, fallbackId: string) {
  if (!node) return { id: fallbackId };
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    file: node.source?.file,
    line: node.source?.line,
  };
}

function uniqueByName<T extends { name?: string }>(values: T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const value of values) {
    const key = String(value.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

function compactMicroFileReadPlan(plan: any) {
  if (!Array.isArray(plan)) return plan || [];
  return plan.slice(0, 5).map((item: any) => ({
    file: item.file,
    reason: item.reason,
    line: item.line,
    line_window: item.line_window,
  }));
}

function compactMicroInvariantImpact(impact: any) {
  if (!impact || typeof impact !== 'object') return impact || null;
  return {
    status: impact.status,
    target: impact.target,
    changed_files: Array.isArray(impact.changed_files) ? impact.changed_files.slice(0, 5) : impact.changed_files,
    impacted_count: impact.impacted_count,
    impacted_invariants: Array.isArray(impact.impacted_invariants) ? impact.impacted_invariants.slice(0, 4).map((invariant: any) => ({
      invariant_id: invariant.invariant_id,
      name: invariant.name,
      invariant_type: invariant.invariant_type,
      impact_score: invariant.impact_score,
      required_checks: Array.isArray(invariant.required_checks) ? invariant.required_checks.slice(0, 4) : invariant.required_checks,
    })) : impact.impacted_invariants,
    required_checks: Array.isArray(impact.required_checks) ? impact.required_checks.slice(0, 6) : impact.required_checks,
  };
}

function compactMicroValidationPlan(plan: any) {
  if (!plan || typeof plan !== 'object') return plan || null;
  return {
    strategy: plan.strategy,
    commands: Array.isArray(plan.commands) ? plan.commands.slice(0, 3) : plan.commands,
    tests_to_inspect: Array.isArray(plan.tests_to_inspect) ? plan.tests_to_inspect.slice(0, 4) : plan.tests_to_inspect,
    manual_checks: Array.isArray(plan.manual_checks) ? plan.manual_checks.slice(0, 6) : plan.manual_checks,
    environment_rule: plan.environment_rule,
    gaps: Array.isArray(plan.gaps) ? plan.gaps.slice(0, 3) : plan.gaps,
  };
}

function compactMicroToolPlan(steps: any) {
  if (!Array.isArray(steps)) return steps || [];
  const required = steps.filter(step => step.required).slice(0, 6);
  const optional = steps.filter(step => !step.required).slice(0, 2);
  return [...required, ...optional].map(step => ({
    order: step.order,
    tool: step.tool,
    args: step.args,
    required: step.required,
  }));
}

export function buildCapabilityMemoryForAgent(
  cas: CASOutput,
  options: {
    target?: string;
    instructions?: string;
    success_criteria?: string[];
    files?: string[];
    limit?: number;
  } = {}
) {
  const capabilities = cas.system_capabilities || [];
  const limit = Math.max(1, Math.min(options.limit || 8, 20));
  const taskText = [
    options.target || '',
    options.instructions || '',
    ...(options.success_criteria || []),
    ...(options.files || []),
  ].join(' ');
  const taskTokens = new Set(meaningfulTokens(taskText));
  const scored = capabilities
    .map(capability => scoreCapabilityForTask(capability, taskTokens, options.files || []))
    .filter(item => item.score > 0 || item.capability.category === 'core' || item.capability.criticality === 'critical')
    .sort((left, right) =>
      right.score - left.score ||
      capabilityRank(right.capability) - capabilityRank(left.capability) ||
      right.capability.operations.length - left.capability.operations.length
    )
    .slice(0, limit);

  const matched = scored.map(({ capability, score, matchedTerms }) => ({
    id: capability.id,
    name: capability.name,
    description: capability.description,
    category: capability.category,
    criticality: capability.criticality,
    score,
    matched_terms: matchedTerms.slice(0, 10),
    related_domains: (capability.related_domains || []).slice(0, 6),
    related_entities: (capability.related_entities || []).slice(0, 6),
    operation_paths: uniqueStrings((capability.operations || [])
      .map(operation => operation.path_or_command || operation.action || '')
      .filter(Boolean))
      .slice(0, 8),
    first_checks: firstCapabilityChecks(capability),
  }));

  const likelyOverlap = matched.filter(capability => capability.score >= 25);
  const reuseDecisions = likelyOverlap.map(capability => ({
    requested_need: capability.matched_terms.length ? capability.matched_terms.join(', ') : capability.name,
    existing_capability: capability.name,
    score: capability.score,
    decision_required: [
      'reuse existing capability',
      'extend existing capability',
      'extract shared behavior',
      'create a new capability only with an explicit distinction',
    ],
    evidence: [
      ...(capability.operation_paths || []).slice(0, 3).map(file => `operation path: ${file}`),
      ...(capability.related_entities || []).slice(0, 3).map(entity => `related entity: ${entity}`),
    ],
  }));

  return {
    product: 'codebase_capability_memory',
    status: likelyOverlap.length > 0
      ? 'possible-existing-capability'
      : capabilities.length > 0 ? 'capability-led-navigation' : 'no-capability-memory',
    task_signal: {
      target: options.target,
      token_count: taskTokens.size,
      matched_capability_count: likelyOverlap.length,
    },
    matched_capabilities: matched,
    reuse_decisions_required: reuseDecisions,
    do_not_rebuild: reuseDecisions.map(decision => ({
      capability: decision.existing_capability,
      rule: 'Do not create parallel behavior until the existing capability has been inspected and the distinction is explicit.',
    })),
    agent_guidance: [
      'Before adding a new service, route, worker, model, or package, compare the requested behavior against matched_capabilities.',
      'Prefer extending the listed operation_paths when the requested behavior belongs to an existing capability.',
      'If a new capability is still needed, name the distinction in the plan and add tests at the existing boundary.',
      'Use the file_read_plan for immediate edits, and use capability_memory to avoid duplicate work across nearby behavior.',
    ],
  };
}

function scoreCapabilityForTask(
  capability: SystemCapability,
  taskTokens: Set<string>,
  files: string[]
): { capability: SystemCapability; score: number; matchedTerms: string[] } {
  const operationPaths = (capability.operations || []).map(operation => operation.path_or_command || operation.action || '');
  const haystack = [
    capability.name,
    capability.description,
    ...(capability.related_domains || []),
    ...(capability.related_entities || []),
    ...operationPaths,
  ].join(' ');
  const capabilityTokens = new Set(meaningfulTokens(haystack));
  const matchedTerms = [...taskTokens].filter(token =>
    capabilityTokens.has(token) ||
    [...capabilityTokens].some(capabilityToken =>
      token.length >= 5 && (capabilityToken.includes(token) || token.includes(capabilityToken))
    )
  );
  const fileHits = files.filter(file => operationPaths.some(operationPath => projectPathsMatch(operationPath, file))).length;
  const lexicalScore = taskTokens.size > 0
    ? Math.round((matchedTerms.length / Math.max(1, Math.min(taskTokens.size, capabilityTokens.size))) * 100)
    : 0;
  const score = Math.min(100,
    lexicalScore +
    fileHits * 20 +
    (capability.category === 'core' ? 8 : 0) +
    (capability.criticality === 'critical' ? 8 : capability.criticality === 'high' ? 4 : 0)
  );
  return { capability, score, matchedTerms };
}

function firstCapabilityChecks(capability: SystemCapability): string[] {
  const checks = [
    ...(capability.operations || []).slice(0, 3).map(operation =>
      operation.path_or_command
        ? `Inspect ${operation.path_or_command} before adding overlapping behavior.`
        : `Inspect ${operation.action} before adding overlapping behavior.`
    ),
  ];
  if ((capability.related_entities || []).length > 0) {
    checks.push(`Check related entities: ${capability.related_entities.slice(0, 4).join(', ')}.`);
  }
  return checks.slice(0, 5);
}

function capabilityRank(capability: SystemCapability): number {
  const category = capability.category === 'core' ? 4 : capability.category === 'supporting' ? 3 : capability.category === 'admin' ? 2 : 1;
  const criticality = capability.criticality === 'critical' ? 4 : capability.criticality === 'high' ? 3 : capability.criticality === 'medium' ? 2 : 1;
  return category + criticality;
}

export function getAgentToolPlan(cas: CASOutput, input: { path: string; task?: AgentTask }) {
  const task = normalizeTask(input.task || {});
  const representativeNodeId = representativeTarget(cas)?.id;
  const target = task.target || inferTargetQueryFromTask(task) || representativeNodeId || 'target-query';
  const nodeId = representativeNodeId || '<node_id from search_nodes>';
  const entryPoint = representativeEntryPoint(cas);
  const chain = (cas.call_chains || [])[0];
  const steps = stepsForTask(input.path, task, target, nodeId, entryPoint?.id, chain?.id);

  return {
    path: input.path,
    generated_at: new Date().toISOString(),
    task,
    rule: 'Use this plan before broad file reads. Source files are for targeted verification and edits after MCP identifies the relevant graph area.',
    steps,
    ...(steps.some(item => item.tool === 'run_answer_pack')
      ? { answer_packs: `Valid run_answer_pack packs: ${describeAnswerPackCatalog()}. Do not guess other pack names; narrow with section: '<id>' instead.` }
      : {}),
    fallback: {
      condition: 'CAS analysis is missing, stale, or returns an error.',
      action: 'Run analyze_codebase. If the error remains, report the MCP/CAS failure and fall back to direct code reading for the task.',
    },
  };
}

async function resolveTaskTarget(cas: CASOutput, projectPath: string, target?: string) {
  const gaps: string[] = [];
  const candidateNodes = new Map<string, CASNode>();
  let selectedNode: CASNode | undefined;

  if (target) {
    const targetFile = normalizeTargetFileForAgent(projectPath, cas.system?.root_path, target);
    const pathLikeTarget = Boolean(targetFile);
    const exactNode = cas.nodes.find(node => node.id === target);
    if (exactNode) {
      selectedNode = exactNode;
      candidateNodes.set(exactNode.id, exactNode);
    }

    const fileMatches = targetFile
      ? cas.nodes.filter(node => nodeMatchesTargetFile(node, targetFile, cas.system?.root_path)).slice(0, 25)
      : [];
    for (const node of fileMatches) {
      candidateNodes.set(node.id, node);
    }
    if (!selectedNode && fileMatches.length > 0) {
      selectedNode = chooseBestFileTargetNode(fileMatches);
    }

    if (!targetFile && targetLooksLikeDocumentationFirstWork(target)) {
      return {
        query: target,
        selected_node_id: null,
        selected_node: null,
        candidates: [],
        gaps,
      };
    }

    const semanticMatches = pathLikeTarget ? [] : await resolveSemanticTargetCandidates(cas, projectPath, target);
    for (const node of semanticMatches) {
      candidateNodes.set(node.id, node);
    }

    if (!pathLikeTarget) {
      const searched = searchNodes(cas, target, { limit: 10 })
        .map(result => cas.nodes.find(node => node.id === result.id))
        .filter((node): node is CASNode => Boolean(node));
      for (const node of searched) {
        candidateNodes.set(node.id, node);
      }

      const naturalMatches = cas.nodes
        .map(node => ({ node, score: scoreNodeForTarget(node, target) }))
        .filter(candidate => candidate.score >= 55)
        .sort((left, right) => right.score - left.score)
        .slice(0, 10)
        .map(candidate => candidate.node);
      for (const node of naturalMatches) {
        candidateNodes.set(node.id, node);
      }

      const routeMatches = (cas.entry_points || [])
        .filter(entry => entryPointMatchesTarget(entry, target))
        .flatMap(entry => [entry.source_node, entry.handler?.node_id].filter(Boolean) as string[])
        .map(nodeId => cas.nodes.find(node => node.id === nodeId))
        .filter((node): node is CASNode => Boolean(node));
      for (const node of routeMatches) {
        candidateNodes.set(node.id, node);
      }
    }

    const semanticRank = new Map<string, number>();
    semanticMatches.forEach((node, index) => {
      if (!semanticRank.has(node.id)) semanticRank.set(node.id, index);
    });
    const scoredCandidates = [...candidateNodes.values()]
      .map(node => {
        const rank = semanticRank.get(node.id);
        const semanticBonus = rank === undefined ? 0 : Math.max(20, 130 - rank * 18);
        const fileBonus = targetFile && nodeMatchesTargetFile(node, targetFile, cas.system?.root_path) ? 500 : 0;
        const pathPenalty = pathLikeTarget && !fileBonus ? -250 : 0;
        return { node, score: scoreNodeForTarget(node, target) + semanticBonus + fileBonus + pathPenalty };
      })
      .sort((left, right) => right.score - left.score);
    if (!selectedNode || (pathLikeTarget && targetFile && !nodeMatchesTargetFile(selectedNode, targetFile, cas.system?.root_path))) {
      selectedNode = scoredCandidates[0]?.node;
    }

    if (!selectedNode) gaps.push(`target: no CAS node resolved for "${target}"`);
    const topCandidate = scoredCandidates[0];
    const ambiguousAlternatives = topCandidate
      ? scoredCandidates.slice(1).filter(candidate =>
        topCandidate.score - candidate.score < 15 &&
        !sameImplementationTarget(topCandidate.node, candidate.node) &&
        isAmbiguousTargetAlternative(candidate.node)
      )
      : [];
    if (ambiguousAlternatives.length > 0) {
      gaps.push(`target: "${target}" is ambiguous; review candidate nodes before editing`);
    }

    return {
      query: target,
      selected_node_id: selectedNode?.id || null,
      selected_node: selectedNode || null,
      candidates: scoredCandidates.map(candidate => ({
        ...summarizeNodeForAgent(candidate.node),
        score: candidate.score,
      })),
      gaps,
    };
  } else {
    selectedNode = representativeTarget(cas);
    if (selectedNode) candidateNodes.set(selectedNode.id, selectedNode);
    else gaps.push('target: no representative CAS node available');
  }

  return {
    query: target || null,
    selected_node_id: selectedNode?.id || null,
    selected_node: selectedNode || null,
    candidates: [...candidateNodes.values()].map(node => ({
      ...summarizeNodeForAgent(node),
      score: scoreNodeForTarget(node, target),
    })),
    gaps,
  };
}

async function resolveSemanticTargetCandidates(
  cas: CASOutput,
  projectPath: string,
  target: string,
): Promise<CASNode[]> {
  try {
    const response = await semanticSearch(projectPath, target, { limit: 10 });
    if (response.degraded) return [];
    return response.results
      .map(result => cas.nodes.find(node => node.id === result.node_id))
      .filter((node): node is CASNode => Boolean(node));
  } catch {
    return [];
  }
}

function summarizeTargetResolutionForAgent(resolution: Awaited<ReturnType<typeof resolveTaskTarget>>) {
  return {
    query: resolution.query,
    selected_node_id: resolution.selected_node_id,
    selected_node: resolution.selected_node ? summarizeNodeForAgent(resolution.selected_node) : null,
    candidates: resolution.candidates,
    gaps: resolution.gaps,
  };
}

function normalizeTargetFileForAgent(projectPath: string, rootPath: string | undefined, target: string): string | null {
  const normalizedTarget = String(target || '').replace(/\\/g, '/').trim();
  if (!isPathLikeAgentTarget(normalizedTarget)) return null;
  const root = (rootPath || projectPath).replace(/\\/g, '/').replace(/\/$/, '');
  if (nodePath.isAbsolute(normalizedTarget)) {
    return normalizeSourceFile(normalizedTarget, root);
  }
  if (normalizedTarget.startsWith(`${root}/`)) {
    return normalizeSourceFile(normalizedTarget, root);
  }
  return normalizedTarget.replace(/^\.\//, '');
}

function isPathLikeAgentTarget(target: string): boolean {
  return /[/.][a-z0-9]+$/i.test(target) && (target.includes('/') || target.includes('\\'));
}

function nodeMatchesTargetFile(node: CASNode, targetFile: string, rootPath?: string): boolean {
  if (!node.source?.file) return false;
  const nodeFile = normalizeSourceFile(node.source.file, rootPath);
  return nodeFile === targetFile || nodeFile.endsWith(`/${targetFile}`) || targetFile.endsWith(`/${nodeFile}`);
}

function chooseBestFileTargetNode(nodes: CASNode[]): CASNode | undefined {
  return [...nodes]
    .sort((left, right) =>
      fileTargetNodeScore(right) - fileTargetNodeScore(left) ||
      (left.source?.line || Number.MAX_SAFE_INTEGER) - (right.source?.line || Number.MAX_SAFE_INTEGER)
    )[0];
}

function fileTargetNodeScore(node: CASNode): number {
  let score = 0;
  if (['class', 'function', 'method', 'service', 'controller', 'handler', 'route', 'api_route'].includes(node.type)) score += 40;
  if (node.category === 'test' || isNonProductAgentTarget(node)) score -= 80;
  if (node.type === 'file') score -= 40;
  if (node.type === 'import' || node.type === 'property' || node.type === 'variable') score -= 30;
  if ((node.metadata as any)?.exported === true) score += 15;
  return score;
}

function sameImplementationTarget(left: CASNode, right: CASNode): boolean {
  return Boolean(left.source?.file && right.source?.file &&
    left.source.file === right.source.file &&
    left.source.line === right.source.line &&
    normalizeIdentifier(left.name) === normalizeIdentifier(right.name));
}

function isAmbiguousTargetAlternative(node: CASNode): boolean {
  if (node.category === 'test' || node.source?.file?.toLowerCase().includes('.spec.')) return false;
  if (['variable', 'property', 'import', 'mock'].includes(node.type)) return false;
  if (node.type.toLowerCase().includes('dto') || node.name.toLowerCase().includes('dto')) return false;
  return true;
}

function summarizeRiskForAgent(risk: ReturnType<typeof assessChangeRisk> | null) {
  if (!risk) return null;
  const summary = risk.change_risk_summary as any;
  const compactSummary = compactChangeRiskSummary(summary);

  if (risk.risk) {
    return {
      risk: risk.risk,
      change_risk_summary: compactSummary,
    };
  }

  if (!summary || typeof summary !== 'object') {
    return { risk: null, change_risk_summary: summary || null };
  }

  return {
    risk: null,
    change_risk_summary: compactSummary,
  };
}

function buildRiskContextForAgent(
  cas: CASOutput,
  options: { targetNode?: CASNode; target?: string; files?: string[]; limit?: number } = {},
) {
  const risks = Array.isArray(cas.change_risks) ? cas.change_risks : [];
  const summary = cas.change_risk_summary as any;
  const nodeById = new Map((cas.nodes || []).map(node => [node.id, node]));
  const riskByNode = new Map(risks.map(risk => [risk.node_id, risk]));
  const targetText = String(options.target || '').toLowerCase();
  const targetRisk = options.targetNode
    ? riskByNode.get(options.targetNode.id) || null
    : risks.find(risk => {
      const node = nodeById.get(risk.node_id);
      const haystack = [risk.node_id, node?.name, node?.qualified_name, node?.source?.file].filter(Boolean).join(' ').toLowerCase();
      return Boolean(targetText && haystack.includes(targetText));
    }) || null;
  const files = uniqueStrings((options.files || [])
    .map(file => normalizeSourceFile(file, cas.system?.root_path))
    .filter(Boolean));
  const fileRisks = risks.filter(risk => {
    const node = nodeById.get(risk.node_id);
    const file = normalizeSourceFile(node?.source?.file || '', cas.system?.root_path);
    return Boolean(file && files.some(targetFile => projectPathsMatch(file, targetFile)));
  });
  const summaryHighRiskIds = Array.isArray(summary?.high_risk_nodes) ? summary.high_risk_nodes : [];
  const summaryUntestedIds = Array.isArray(summary?.untested_critical_paths) ? summary.untested_critical_paths : [];
  const summaryRiskIds = [...summaryHighRiskIds, ...summaryUntestedIds]
    .map((item: any) => typeof item === 'string' ? item : item?.node_id || item?.id)
    .filter(Boolean);
  const scopedRisks = uniqueRisks([
    ...(targetRisk ? [targetRisk] : []),
    ...fileRisks,
  ])
    .sort((left, right) => changeRiskRank(right) - changeRiskRank(left))
    .slice(0, options.limit || 6)
    .map(risk => compactChangeRiskForAgent(risk, nodeById.get(risk.node_id)));

  const repoTopRisks = uniqueRisks([
    ...summaryRiskIds.map((id: string) => riskByNode.get(id)).filter(Boolean),
    ...risks,
  ])
    .sort((left, right) => changeRiskRank(right) - changeRiskRank(left))
    .slice(0, options.limit || 6)
    .map(risk => compactChangeRiskForAgent(risk, nodeById.get(risk.node_id)));

  const topFactors = riskFactorSummary(scopedRisks.length ? scopedRisks : repoTopRisks);
  return {
    status: risks.length > 0 ? 'ready' : 'unavailable',
    target_risk: targetRisk ? compactChangeRiskForAgent(targetRisk, nodeById.get(targetRisk.node_id)) : null,
    scope: targetRisk ? 'target' : fileRisks.length > 0 ? 'files' : 'repo',
    summary: {
      total_high_risk_nodes: summaryHighRiskIds.length || risks.filter(risk => risk.risk_level === 'critical' || risk.risk_level === 'high').length,
      total_untested_critical_paths: summaryUntestedIds.length,
      top_risk_factors: topFactors,
    },
    top_risks: scopedRisks,
    repo_top_risks: repoTopRisks,
    agent_rules: [
      scopedRisks.length
        ? 'Before editing any scoped risk surface, inspect its callers, callees, tests, and behavioral invariants.'
        : 'No direct risk matched the selected target or first-read files; use repo_top_risks only as background, not as the edit target.',
      'Use assess_change_risk for the selected node before changes that touch high-risk files or entry points.',
      'When risk_context names no direct tests, inspect adjacent tests or add focused coverage before finalizing behavior changes.',
    ],
  };
}

function compactChangeRiskForAgent(risk: any, node?: CASNode) {
  const factors = Array.isArray(risk.risk_factors) ? risk.risk_factors : [];
  return {
    node_id: risk.node_id,
    name: node?.name || risk.node_id,
    type: node?.type || null,
    file: node?.source?.file || null,
    line: node?.source?.line || null,
    risk_level: risk.risk_level,
    factors: factors.slice(0, 4).map((factor: any) => ({
      factor: factor.factor,
      severity: factor.severity,
      details: factor.details,
    })),
    direct_callers: Array.isArray(risk.downstream_impact?.direct_callers) ? risk.downstream_impact.direct_callers.slice(0, 4) : [],
    affected_entry_points: Array.isArray(risk.downstream_impact?.affected_entry_points) ? risk.downstream_impact.affected_entry_points.slice(0, 4) : [],
    test_protection: risk.test_protection ? {
      has_direct_tests: Boolean(risk.test_protection.has_direct_tests),
      has_integration_tests: Boolean(risk.test_protection.has_integration_tests),
      test_ids: Array.isArray(risk.test_protection.test_ids) ? risk.test_protection.test_ids.slice(0, 4) : [],
    } : null,
    recommendations: Array.isArray(risk.recommendations) ? risk.recommendations.slice(0, 3) : [],
  };
}

function compactMinimalRiskContext(context: any) {
  if (!context || typeof context !== 'object') return context || null;
  return {
    status: context.status,
    target_risk: context.target_risk ? compactRiskContextItem(context.target_risk, 2) : null,
    scope: context.scope,
    summary: context.summary ? {
      total_high_risk_nodes: context.summary.total_high_risk_nodes,
      total_untested_critical_paths: context.summary.total_untested_critical_paths,
      top_risk_factors: Array.isArray(context.summary.top_risk_factors) ? context.summary.top_risk_factors.slice(0, 3) : [],
    } : null,
    top_risks: Array.isArray(context.top_risks) ? context.top_risks.slice(0, 4).map((risk: any) => compactRiskContextItem(risk, 2)) : [],
    repo_top_risks: Array.isArray(context.repo_top_risks) ? context.repo_top_risks.slice(0, 3).map((risk: any) => compactRiskContextItem(risk, 2)) : [],
    agent_rules: Array.isArray(context.agent_rules) ? context.agent_rules.slice(0, 3) : [],
  };
}

function compactRiskContextForMicroRepo(context: any) {
  if (!context || typeof context !== 'object') return context || null;
  return {
    status: context.status,
    target_risk: context.target_risk ? compactRiskContextItem(context.target_risk, 3) : null,
    scope: context.scope,
    summary: context.summary,
    top_risks: Array.isArray(context.top_risks) ? context.top_risks.slice(0, 5).map((risk: any) => compactRiskContextItem(risk, 3)) : [],
    repo_top_risks: Array.isArray(context.repo_top_risks) ? context.repo_top_risks.slice(0, 4).map((risk: any) => compactRiskContextItem(risk, 2)) : [],
    agent_rules: Array.isArray(context.agent_rules) ? context.agent_rules.slice(0, 3) : [],
  };
}

function compactRiskContextItem(item: any, limit: number) {
  if (!item || typeof item !== 'object') return item || null;
  return {
    node_id: item.node_id,
    name: item.name,
    type: item.type,
    file: item.file,
    risk_level: item.risk_level,
    factors: Array.isArray(item.factors) ? item.factors.slice(0, limit) : [],
    has_direct_tests: item.test_protection?.has_direct_tests,
    affected_entry_points: Array.isArray(item.affected_entry_points) ? item.affected_entry_points.slice(0, limit) : [],
    recommendations: Array.isArray(item.recommendations) ? item.recommendations.slice(0, limit) : [],
  };
}

function uniqueRisks(risks: any[]): any[] {
  const seen = new Set<string>();
  const result = [];
  for (const risk of risks) {
    if (!risk?.node_id || seen.has(risk.node_id)) continue;
    seen.add(risk.node_id);
    result.push(risk);
  }
  return result;
}

function changeRiskRank(risk: any): number {
  const level = String(risk?.risk_level || '').toLowerCase();
  const levelScore = level === 'critical' ? 400 : level === 'high' ? 300 : level === 'medium' ? 200 : level === 'low' ? 100 : 0;
  const factors = Array.isArray(risk?.risk_factors) ? risk.risk_factors : [];
  const factorScore = factors.reduce((score: number, factor: any) => {
    const severity = String(factor?.severity || '').toLowerCase();
    return score + (severity === 'high' ? 10 : severity === 'medium' ? 5 : severity === 'low' ? 2 : 0);
  }, 0);
  const untested = risk?.test_protection?.has_direct_tests === false ? 15 : 0;
  return levelScore + factorScore + untested;
}

function riskFactorSummary(risks: any[]): string[] {
  const counts = new Map<string, number>();
  for (const risk of risks) {
    for (const factor of risk.factors || []) {
      if (!factor?.factor) continue;
      counts.set(factor.factor, (counts.get(factor.factor) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([factor, count]) => `${factor} (${count})`);
}

function summarizeSystemHealthForAgent(cas: CASOutput) {
  const health = cas.system_health;
  if (!health) return null;
  return {
    score: health.score,
    status: health.status,
    coherence: health.coherence,
    top_risks: health.risk_areas.slice(0, 6).map(area => ({
      type: area.type,
      severity: area.severity,
      title: area.title,
      affected_files: area.affected_files?.slice(0, 5),
      recommendation: area.recommendation,
      agent_guidance: area.agent_guidance,
    })),
    remediation: {
      immediate: health.remediation.immediate.slice(0, 6),
      agent_rules: health.remediation.agent_rules.slice(0, 6),
      validation_tools: health.remediation.validation_tools,
    },
  };
}

function compactSystemHealthForAgent(health: any) {
  if (!health || typeof health !== 'object') return health || null;
  return {
    score: health.score,
    status: health.status,
    coherence: health.coherence ? {
      status: health.coherence.status,
      primary_paradigms: Array.isArray(health.coherence.primary_paradigms) ? health.coherence.primary_paradigms.slice(0, 4) : health.coherence.primary_paradigms,
      conflicting_paradigms: Array.isArray(health.coherence.conflicting_paradigms) ? health.coherence.conflicting_paradigms.slice(0, 4) : health.coherence.conflicting_paradigms,
      duplication_signals: health.coherence.duplication_signals,
    } : null,
    top_risks: Array.isArray(health.top_risks) ? health.top_risks.slice(0, 4) : health.top_risks,
    remediation: health.remediation ? {
      immediate: Array.isArray(health.remediation.immediate) ? health.remediation.immediate.slice(0, 4) : health.remediation.immediate,
      agent_rules: Array.isArray(health.remediation.agent_rules) ? health.remediation.agent_rules.slice(0, 4) : health.remediation.agent_rules,
      validation_tools: health.remediation.validation_tools,
    } : null,
  };
}

function compactChangeRiskSummary(summary: any) {
  if (!summary || typeof summary !== 'object') return summary || null;
  return {
    total_high_risk_nodes: Array.isArray(summary.high_risk_nodes) ? summary.high_risk_nodes.length : 0,
    total_medium_risk_nodes: Array.isArray(summary.medium_risk_nodes) ? summary.medium_risk_nodes.length : 0,
    total_low_risk_nodes: Array.isArray(summary.low_risk_nodes) ? summary.low_risk_nodes.length : 0,
    top_high_risk_nodes: Array.isArray(summary.high_risk_nodes) ? summary.high_risk_nodes.slice(0, 8) : [],
    top_risk_factors: Array.isArray(summary.top_risk_factors) ? summary.top_risk_factors.slice(0, 8) : [],
    recommendation: 'Call assess_change_risk for the selected node or area when the full repository risk summary is needed.',
  };
}

function summarizeTestsForAgent(tests: any) {
  if (!tests || typeof tests !== 'object') return tests || null;
  const suites = Array.isArray(tests.suites) ? tests.suites : [];
  const mocks = Array.isArray(tests.mocks) ? tests.mocks : [];
  const fixtures = Array.isArray(tests.fixtures) ? tests.fixtures : [];
  return {
    total_suites: tests.total_suites ?? suites.length,
    total_mocks: tests.total_mocks ?? mocks.length,
    total_fixtures: tests.total_fixtures ?? fixtures.length,
    suites: suites.slice(0, 5).map((suite: any) => {
      const suiteTests = Array.isArray(suite.tests) ? suite.tests : [];
      return {
        id: suite.id,
        name: suite.name,
        file_path: suite.file_path,
        test_type: suite.test_type,
        framework: suite.framework,
        test_count: suiteTests.length,
        tests: suiteTests.slice(0, 6).map((test: any) => ({
          id: test.id,
          name: test.name,
          test_type: test.test_type,
          source: test.source,
          status: test.status,
        })),
      };
    }),
    mocks: mocks.slice(0, 5).map((mock: any) => ({
      id: mock.id,
      name: mock.name,
      target_node: mock.target_node,
      file_path: mock.file_path,
    })),
    fixtures: fixtures.slice(0, 8).map((fixture: any) => ({
      id: fixture.id,
      name: fixture.name,
      type: fixture.type,
      file_path: fixture.file_path,
    })),
    resolution: tests.resolution || undefined,
    recommendation: 'Call find_tests for the full test graph when editing test setup or mocks.',
  };
}

function summarizeBehavioralInvariantsForAgent(result: any) {
  if (!result || typeof result !== 'object') return result || null;
  const invariants = Array.isArray(result.invariants) ? result.invariants : [];
  const summary = result.summary && typeof result.summary === 'object'
    ? {
      total: result.summary.total,
      by_type: result.summary.by_type,
      gaps: result.summary.gaps,
    }
    : result.summary || null;
  return {
    total: result.total ?? invariants.length,
    offset: result.offset,
    limit: result.limit,
    summary,
    invariants: invariants.slice(0, 8).map((invariant: any) => ({
      id: invariant.id,
      name: invariant.name,
      invariant_type: invariant.invariant_type,
      description: invariant.description,
      confidence: invariant.confidence,
      enforcement_summary: invariant.enforcement_summary,
      scope: compactInvariantScope(invariant.scope),
      enforcement_count: Array.isArray(invariant.enforcement) ? invariant.enforcement.length : 0,
      evidence_count: Array.isArray(invariant.evidence) ? invariant.evidence.length : 0,
      related_tests: Array.isArray(invariant.related_tests) ? invariant.related_tests.slice(0, 6) : invariant.related_tests,
      related_boundaries: Array.isArray(invariant.related_boundaries) ? invariant.related_boundaries.slice(0, 6) : invariant.related_boundaries,
      related_entities: Array.isArray(invariant.related_entities) ? invariant.related_entities.slice(0, 6) : invariant.related_entities,
      gaps: Array.isArray(invariant.gaps) ? invariant.gaps.slice(0, 6) : invariant.gaps,
    })),
    recommendation: 'Call get_behavioral_invariants for complete invariant evidence before changing boundary-sensitive behavior.',
  };
}

function compactInvariantScope(scope: any) {
  if (!scope || typeof scope !== 'object') return scope || null;
  return {
    file_paths: Array.isArray(scope.file_paths) ? scope.file_paths.slice(0, 8) : scope.file_paths,
    node_ids: Array.isArray(scope.node_ids) ? scope.node_ids.slice(0, 8) : scope.node_ids,
    node_id_count: Array.isArray(scope.node_ids) ? scope.node_ids.length : undefined,
    entity_names: Array.isArray(scope.entity_names) ? scope.entity_names.slice(0, 8) : scope.entity_names,
    field_names: Array.isArray(scope.field_names) ? scope.field_names.slice(0, 8) : scope.field_names,
  };
}

function summarizeInvariantImpactForAgent(impact: any) {
  if (!impact || typeof impact !== 'object') return impact || null;
  const impacted = Array.isArray(impact.impacted_invariants) ? impact.impacted_invariants : [];
  return {
    status: impact.status,
    target: impact.target,
    changed_files: Array.isArray(impact.changed_files) ? impact.changed_files.slice(0, 8) : impact.changed_files,
    impacted_count: impact.impacted_count ?? impacted.length,
    impacted_invariants: impacted.slice(0, 8).map((invariant: any) => ({
      invariant_id: invariant.invariant_id,
      name: invariant.name,
      invariant_type: invariant.invariant_type,
      confidence: invariant.confidence,
      status: invariant.status,
      impact_score: invariant.impact_score,
      matched_files: Array.isArray(invariant.matched_files) ? invariant.matched_files.slice(0, 6) : invariant.matched_files,
      matched_terms: Array.isArray(invariant.matched_terms) ? invariant.matched_terms.slice(0, 10) : invariant.matched_terms,
      touched_tests: Array.isArray(invariant.touched_tests) ? invariant.touched_tests.slice(0, 6) : invariant.touched_tests,
      touched_migrations: Array.isArray(invariant.touched_migrations) ? invariant.touched_migrations.slice(0, 6) : invariant.touched_migrations,
      gaps: Array.isArray(invariant.gaps) ? invariant.gaps.slice(0, 6) : invariant.gaps,
      required_checks: Array.isArray(invariant.required_checks) ? invariant.required_checks.slice(0, 8) : invariant.required_checks,
      evidence_count: Array.isArray(invariant.evidence) ? invariant.evidence.length : 0,
    })),
    required_checks: Array.isArray(impact.required_checks) ? impact.required_checks.slice(0, 10) : impact.required_checks,
    recommendation: 'Call validate_behavioral_invariants after editing files that touch impacted invariants.',
  };
}

function inferTargetQueryFromTask(task: AgentTask): string | undefined {
  if (task.task_type === 'orient') return undefined;
  const text = [
    task.instructions,
    ...(task.success_criteria || []),
  ].filter(Boolean).join(' ').trim();
  if (!text) return undefined;

  const codeFragments = [...text.matchAll(/`([^`]{2,120})`/g)]
    .map(match => match[1])
    .filter(fragment => !/\s/.test(fragment) || /[./_-]/.test(fragment));
  const identifierFragments = text.match(/\b[A-Za-z_][A-Za-z0-9_]*(?:Service|Controller|Repository|Guard|Handler|Resolver|Component|Store|Module|Provider|Middleware|Entity|Model|Id|ID)?\b/g) || [];
  const meaningfulIdentifiers = identifierFragments
    .filter(fragment => fragment.length >= 5 && !['Preserve', 'Focused', 'TypeScript', 'Change', 'Update', 'Existing'].includes(fragment))
    .slice(0, 12);
  const compact = [...codeFragments, ...meaningfulIdentifiers, text]
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
  return compact || undefined;
}

function enrichTargetQueryWithCapabilityEvidence(cas: CASOutput, target?: string): string | undefined {
  if (!target) return target;
  if (looksLikeFileTarget(target)) return target;
  const targetTokens = meaningfulTokens(target);
  if (targetTokens.length === 0) return target;
  const matchingCapability = (cas.system_capabilities || [])
    .filter(capability => targetLooksLikeCapabilityName(target, capability.name))
    .map(capability => ({
      capability,
      overlap: meaningfulTokens([
        capability.name,
        capability.description,
        ...(capability.related_entities || []),
        ...(capability.related_domains || []),
      ].filter(Boolean).join(' ')).filter(token => targetTokens.includes(token)).length,
    }))
    .filter(item => item.overlap > 0)
    .sort((left, right) => right.overlap - left.overlap || String(left.capability.name || '').length - String(right.capability.name || '').length)[0]?.capability;
  if (!matchingCapability) return target;

  const operationHints = (matchingCapability.operations || [])
    .flatMap(operation => [
      operation.path_or_command,
      operation.action,
      operation.entry_point_id,
    ])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .slice(0, 6);
  const entryPointHints = (cas.entry_points || [])
    .filter(entry => operationHints.includes(entry.id) || operationHints.includes(entry.name) || operationHints.includes(entry.trigger?.path || ''))
    .flatMap(entry => [
      entry.name,
      entry.trigger?.path,
      entry.handler?.method_name,
    ])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .slice(0, 6);
  const entityHints = (matchingCapability.related_entities || []).slice(0, 4);
  const enriched = uniqueStrings([
    target,
    matchingCapability.name,
    ...operationHints,
    ...entryPointHints,
    ...entityHints,
  ]).join(' ');
  return enriched.slice(0, 500);
}

function targetLooksLikeCapabilityName(target: string, capabilityName?: string): boolean {
  const normalizedTarget = meaningfulTokens(target).join(' ');
  const normalizedCapability = meaningfulTokens(capabilityName || '').join(' ');
  if (!normalizedTarget || !normalizedCapability) return false;
  if (normalizedTarget === normalizedCapability) return true;
  if (!/\bmanagement\b/i.test(target) || meaningfulTokens(target).length > 3) return false;
  return normalizedCapability.includes(normalizedTarget) || normalizedTarget.includes(normalizedCapability);
}

function looksLikeFileTarget(target: string): boolean {
  return /[\\/]/.test(target) || /\.(?:[cm]?[tj]sx?|py|rs|go|php|cs|java|dart|rb|sql|tf|hcl|json|yaml|yml|md)$/i.test(target);
}

function scoreNodeForTarget(node: CASNode, target?: string): number {
  if (!target) return 50;
  const query = target.toLowerCase();
  const name = node.name.toLowerCase();
  const qualifiedName = node.qualified_name?.toLowerCase() || '';
  const file = node.source?.file?.toLowerCase() || '';
  const targetTokens = meaningfulTokens(target);
  const nodeTokens = meaningfulTokens([
    node.name,
    node.qualified_name,
    node.source?.file,
    node.description,
    ...(node.tags || []),
  ].filter(Boolean).join(' '));
  const normalizedQuery = normalizeIdentifier(target);
  const normalizedName = normalizeIdentifier(node.name);
  const normalizedFile = normalizeIdentifier(node.source?.file || '');
  const normalizedFileBase = normalizeIdentifier(node.source?.file ? nodePath.basename(node.source.file).replace(/\.[^.]+$/, '') : '');
  const routeIntent = targetHasRouteIntent(target, targetTokens);
  let score = 0;

  if (node.id === target) score += 200;
  if (name === query) score += 120;
  if (name.startsWith(query)) score += 70;
  if (name.includes(query)) score += 45;
  if (qualifiedName.includes(query)) score += 30;
  if (file.includes(query)) score += 25;
  if (normalizedName.length >= 6 && normalizedQuery.includes(normalizedName)) {
    score += 85;
    if (['function', 'method', 'handler', 'service'].includes(node.type) || node.subcategories?.includes('handler')) {
      score += 95;
    }
  }
  if (normalizedFile.length >= 10 && normalizedQuery.includes(normalizedFile)) score += 160;
  if (normalizedFileBase.length >= 6 && normalizedQuery.includes(normalizedFileBase)) score += 70;
  if ((node.type === 'route' || node.type === 'api_route') && routeIntent && normalizedName.length >= 6 && normalizedQuery.includes(normalizedName)) score += 220;
  if ((node.type === 'handler' || node.subcategories?.includes('handler')) && targetTokens.includes('route')) score += 70;

  const matchedTokens = targetTokens.filter(token =>
    nodeTokens.some(nodeToken => nodeToken === token || nodeToken.includes(token) || (token.length >= 5 && token.includes(nodeToken)))
  );
  if (matchedTokens.length > 0) {
    score += matchedTokens.length * 14;
    score += Math.round((matchedTokens.length / Math.max(1, targetTokens.length)) * 45);
  }
  const nodeNameTokens = meaningfulTokens(node.name);
  if (nodeNameTokens.length > 1 && nodeNameTokens.every(token => targetTokens.includes(token))) {
    score += 60;
  }

  const preferredTypes = ['controller', 'service', 'guard', 'middleware', 'gateway', 'resolver', 'handler', 'route', 'api_route', 'react_page', 'custom_hook', 'class', 'function', 'method'];
  if (preferredTypes.includes(node.type)) score += 20;
  if (isSyntheticCallsiteNode(node)) score -= 45;
  if (node.type === 'file' || node.type === 'import') score -= 100;
  if (node.type === 'mock') score -= 90;
  if (node.type === 'test' || node.category === 'test' || node.source?.file?.toLowerCase().includes('.spec.')) score -= 85;
  if (isNonProductAgentTarget(node)) score -= 180;
  if (node.type === 'property' || node.type === 'variable') score -= 70;
  if (node.type.toLowerCase().includes('dto')) score -= 35;
  if (node.name.toLowerCase().includes('dto')) score -= 35;
  if (file.startsWith('legacy/') && !targetTokens.includes('legacy')) score -= 140;
  if (hasAnalyzerMaintenanceIntent(targetTokens)) {
    if (/packages\/analyzer-core\/src\/analyzer\//.test(file)) score += 110;
    if (/apps\/mcp-server\/src\/(analysis|agent|idiom|query|server|cli|machine|storage)/.test(file)) score += 80;
    if (targetTokens.some(token => ['capability', 'capabilities', 'summary', 'summaries'].includes(token)) &&
      /orchestrator|capability|domain|analysis-usefulness-review/.test(file)) {
      score += 150;
    }
    if (/buildquickdescription|descriptionsafecapabilityname|buildsystemcapabilities|buildterminalcapabilities/i.test(normalizedName)) {
      score += 180;
    }
    if (/legacy\//.test(file)) score -= 120;
  }

  return score;
}

function hasAnalyzerMaintenanceIntent(tokens: string[]): boolean {
  return tokens.some(token => ['analyzer', 'analysis', 'cas', 'capability', 'capabilities', 'summary', 'summaries', 'idiom', 'idioms', 'mcp', 'usefulness', 'review'].includes(token));
}

function isNonProductAgentTarget(node: CASNode): boolean {
  const text = [
    node.id,
    node.name,
    node.qualified_name,
    node.source?.file,
  ].filter(Boolean).join('/');
  return isNonProductSourceText(text);
}

function isNonProductSourceText(value: string): boolean {
  const text = value.replace(/\\/g, '/').toLowerCase();
  return /(^|[/.])(fixtures?|__fixtures__|__mocks__|mocks?|samples?|examples?|generated|dist|build|coverage)([/.]|$)/.test(text) ||
    /(^|[/.])(\.klauro[^/]*|\.claude|\.codex|\.agents|worktrees?|agent-worktrees?)([/.]|$)/.test(text) ||
    /(^|[/.])legacy([/.]|$)/.test(text) ||
    /(^|[/.])(tests?|__tests__|spec|e2e|cypress|playwright)([/.]|$)/.test(text) ||
    /\.(test|spec|stories|story)\.[a-z0-9]+$/.test(text);
}

function targetHasRouteIntent(target: string, targetTokens: string[]): boolean {
  if (/\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+\//i.test(target)) return true;
  if (/\/[^/\s]+/.test(target)) return true;
  return targetTokens.some(token => [
    'api',
    'endpoint',
    'route',
    'router',
    'http',
    'request',
    'response',
    'controller',
    'get',
    'post',
    'put',
    'patch',
    'delete',
  ].includes(token));
}

function meaningfulTokens(value: string): string[] {
  const stopwords = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'to',
    'for',
    'of',
    'in',
    'on',
    'by',
    'with',
    'when',
    'from',
    'into',
    'must',
    'should',
    'only',
    'same',
    'different',
    'uniqueness',
    'unique',
    'manage',
    'managed',
    'manager',
    'managers',
    'management',
  ]);
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(token => token.length >= 2 && !stopwords.has(token));
}

function normalizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase();
}

function isSyntheticCallsiteNode(node: CASNode): boolean {
  return node.id.startsWith('callee_') ||
    node.subcategories?.includes('callee') === true ||
    node.description?.toLowerCase().startsWith('called by handler') === true;
}

function entryPointMatchesTarget(entry: CASEntryPoint, target: string): boolean {
  const query = target.toLowerCase();
  const route = entry.trigger?.path || '';
  return entry.id === target ||
    entry.name.toLowerCase().includes(query) ||
    Boolean(route && routesCompatibleForAgent(route, target));
}

function routesCompatibleForAgent(actual: string, expected: string): boolean {
  const left = normalizeRouteForAgent(actual);
  const right = normalizeRouteForAgent(expected);
  if (left === right) return true;
  const leftParts = left.split('/').filter(Boolean);
  const rightParts = right.split('/').filter(Boolean);
  if (leftParts.length !== rightParts.length) return left.endsWith(right) || right.endsWith(left);
  return leftParts.every((part, index) => part === rightParts[index] || part === ':param' || rightParts[index] === ':param');
}

function normalizeRouteForAgent(value: string): string {
  return value
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/[?#].*$/, '')
    .replace(/\[[^\]]+\]/g, ':param')
    .replace(/:[a-z0-9_]+/g, ':param')
    .replace(/\{[^}]+\}/g, ':param')
    .replace(/\$\{[^}]+\}/g, ':param')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '') || '/';
}

function buildEntryContext(cas: CASOutput, task: Required<Pick<AgentTask, 'task_type'>> & AgentTask, nodeId?: string) {
  const relatedEntries = nodeId
    ? (cas.entry_points || []).filter(entry =>
        !isNonProductEntryPoint(cas, entry) &&
        (entry.source_node === nodeId ||
          entry.handler?.node_id === nodeId ||
          entry.connected_nodes?.includes(nodeId))
      )
    : [];
  const selectedEntry = relatedEntries[0] || representativeEntryPoint(cas);
  const chains = selectedEntry
    ? getCallChain(cas, { entryPointId: selectedEntry.id, limit: 5 })
    : getCallChain(cas, { limit: 5 });

  return {
    task_type: task.task_type,
    related_entry_points: relatedEntries.slice(0, 5).map(entry => ({
      id: entry.id,
      name: entry.name,
      type: entry.type,
      trigger: entry.trigger,
      handler: entry.handler,
    })),
    representative_entry_point: selectedEntry ? {
      id: selectedEntry.id,
      name: selectedEntry.name,
      type: selectedEntry.type,
      trigger: selectedEntry.trigger,
      handler: selectedEntry.handler,
    } : null,
    call_chains: summarizeCallChainsForAgent(chains),
  };
}

function summarizeCallChainsForAgent(chains: unknown) {
  if (!chains || typeof chains !== 'object') return chains;
  const payload = chains as any;
  const chainItems = Array.isArray(payload.chains) ? payload.chains : [];
  return {
    total: payload.total ?? chainItems.length,
    offset: payload.offset,
    limit: payload.limit,
    chains: chainItems.slice(0, 5).map((chain: any) => ({
      id: chain.id,
      chain_type: chain.chain_type,
      entry_point: chain.entry_point ? {
        entry_point_id: chain.entry_point.entry_point_id,
        method_name: chain.entry_point.method_name,
        route_pattern: chain.entry_point.route_pattern,
        http_method: chain.entry_point.http_method,
      } : undefined,
      exit_point: chain.exit_point ? {
        exit_point_id: chain.exit_point.exit_point_id,
        exit_type: chain.exit_point.exit_type,
        service_name: chain.exit_point.service_name,
      } : undefined,
      call_path_length: Array.isArray(chain.call_path) ? chain.call_path.length : 0,
      call_path_sample: Array.isArray(chain.call_path)
        ? chain.call_path.slice(0, 8).map((step: any) => ({
          node_id: step.node_id,
          name: step.name,
          type: step.type,
          depth: step.depth,
        }))
        : [],
      criticality: chain.criticality,
      risk_level: chain.risk_analysis?.risk_level,
    })),
  };
}

function buildFileReadPlan(
  cas: CASOutput,
  selectedNode: CASNode | undefined,
  callers: ReturnType<typeof getCallers> | null,
  callees: ReturnType<typeof getCallees> | null,
  tests: ReturnType<typeof findTests>,
  entryContext: ReturnType<typeof buildEntryContext>
): FileReadPlanItem[] {
  const items = new Map<string, FileReadPlanItem>();
  const rootPath = cas.system?.root_path;
  const addNode = (node: CASNode | undefined, reason: string) => {
    if (!node?.source?.file) return;
    const file = normalizeSourceFile(node.source.file, rootPath);
    const existing = items.get(file);
    if (existing) {
      if (!existing.node_ids.includes(node.id)) existing.node_ids.push(node.id);
      if (!existing.reason.includes(reason)) existing.reason = `${existing.reason}; ${reason}`;
      return;
    }
    items.set(file, {
      file,
      reason,
      node_ids: [node.id],
      line: node.source.line,
      line_window: buildLineWindow(node),
    });
  };

  addNode(selectedNode, 'selected target');

  for (const caller of (callers?.callers || []).filter(caller => isBehavioralReadPlanLink(caller.via)).slice(0, 5)) {
    addNode(cas.nodes.find(node => node.id === caller.node_id), `caller via ${caller.via}`);
  }

  for (const callee of (callees?.callees || []).filter(callee => isBehavioralReadPlanLink(callee.via)).slice(0, 5)) {
    addNode(cas.nodes.find(node => node.id === callee.node_id), `callee via ${callee.via}`);
  }

  const testSuites = uniqueTestSuites([
    ...((tests.suites || []).slice(0, 5) as AgentTestSuiteRef[]),
    ...inferRelatedTestSuites(cas, selectedNode),
  ]).slice(0, 8);

  for (const suite of testSuites) {
    if (!suite.file_path) continue;
    const file = normalizeSourceFile(suite.file_path, rootPath);
    const existing = items.get(file);
    if (existing) {
      if (!existing.reason.includes('test coverage')) existing.reason = `${existing.reason}; test coverage`;
    } else {
      items.set(file, {
        file,
        reason: `test coverage${suite.name ? `: ${suite.name}` : ''}`,
        node_ids: [],
        line_window: suiteLineWindow(cas, file),
      });
    }
  }

  const representativeEntry = entryContext.representative_entry_point;
  if (representativeEntry?.handler?.file && !isNonProductSourceText(representativeEntry.handler.file)) {
    const file = normalizeSourceFile(representativeEntry.handler.file, rootPath);
    const existing = items.get(file);
    if (existing) {
      if (!existing.reason.includes('representative entry point')) existing.reason = `${existing.reason}; representative entry point`;
    } else {
      items.set(file, {
        file,
        reason: 'representative entry point',
        node_ids: representativeEntry.handler.node_id ? [representativeEntry.handler.node_id] : [],
        line: representativeEntry.handler.line,
        line_window: handlerLineWindow(representativeEntry.handler.line),
      });
    }
  }

  return [...items.values()].slice(0, 12);
}

function targetFileReadPlanItem(file: string): FileReadPlanItem {
  return {
    file,
    reason: 'explicit file path target; CAS node mapping may be stale or missing',
    node_ids: [],
    line_window: {
      start: 1,
      end: 220,
      instruction: `Read ${file} lines 1-220 first; expand only if the local context or tests require it.`,
    },
  };
}

function augmentFileReadPlanWithTaskHints(
  cas: CASOutput,
  plan: FileReadPlanItem[],
  task: AgentTask,
): FileReadPlanItem[] {
  const taskText = [
    task.task_type,
    task.target,
    task.instructions,
    ...(task.success_criteria || []),
  ].filter(Boolean).join(' ');
  const tokens = tokenizeTaskHint(taskText);
  if (tokens.size === 0) return plan;

  const rootPath = cas.system?.root_path;
  const existing = new Set(plan.map(item => item.file));
  const likelyFocusedTests = shouldSuggestFocusedRegressionTest(tokens)
    ? inferLikelyNewTestPlanItems(plan, existing)
    : [];
  for (const item of likelyFocusedTests) existing.add(item.file);
  const candidates = collectTaskHintCandidateFiles(cas, rootPath)
    .filter(file => !existing.has(file) && shouldIncludeTaskHintCandidate(file, tokens))
    .map(file => ({ file, score: taskHintFileScore(file, tokens) }))
    .filter(candidate => candidate.score >= 18)
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .slice(0, 5);

  if (candidates.length === 0 && likelyFocusedTests.length === 0) return plan;
  const sourceItems = plan.filter(item => !isTestPath(item.file));
  const testItems = plan.filter(item => isTestPath(item.file));
  const hintItems = candidates.map(candidate => taskHintReadPlanItem(candidate.file, candidate.score));
  if (targetLooksLikeDocumentationFirstWork(taskText)) {
    const documentationItems = hintItems.filter(item => isDocumentationPath(item.file));
    const nonDocumentationItems = hintItems.filter(item => !isDocumentationPath(item.file));
    return [
      ...documentationItems,
      ...sourceItems,
      ...likelyFocusedTests,
      ...testItems,
      ...nonDocumentationItems,
    ];
  }
  return [
    ...sourceItems,
    ...likelyFocusedTests,
    ...testItems,
    ...hintItems,
  ];
}

function shouldSuggestFocusedRegressionTest(tokens: Set<string>): boolean {
  return hasAny(tokens, ['test', 'tests', 'coverage', 'regression', 'contract', 'assert']);
}

function inferLikelyNewTestPlanItems(plan: FileReadPlanItem[], existing: Set<string>): FileReadPlanItem[] {
  return plan
    .filter(item => !isTestPath(item.file) && /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(item.file))
    .slice(0, 2)
    .flatMap(item => focusedTestPathCandidates(item.file))
    .filter(file => !existing.has(file))
    .slice(0, 2)
    .map(file => ({
      file,
      reason: 'likely focused regression test path; create it if missing',
      node_ids: [],
      line_window: {
        start: 1,
        end: 220,
        instruction: `Create or inspect ${file} for focused regression coverage.`,
      },
    }));
}

function focusedTestPathCandidates(sourceFile: string): string[] {
  const normalized = sourceFile.replace(/\\/g, '/').replace(/^\.\//, '');
  const base = normalized.split('/').pop() || normalized;
  const extension = base.match(/\.(tsx?|jsx?|mjs|cjs)$/i)?.[1] || 'ts';
  const stem = base.replace(/\.(tsx?|jsx?|mjs|cjs)$/i, '');
  const normalizedExtension = extension === 'tsx' ? 'tsx' : extension === 'jsx' ? 'jsx' : extension.includes('js') ? 'js' : 'ts';
  return uniqueStrings([
    `tests/${stem}.test.${normalizedExtension}`,
    `tests/${stem}.spec.${normalizedExtension}`,
  ]);
}

function collectTaskHintCandidateFiles(cas: CASOutput, rootPath?: string): string[] {
  const fromCas = uniqueStrings((cas.nodes || [])
    .map(node => node.source?.file)
    .filter((file): file is string => Boolean(file))
    .map(file => normalizeSourceFile(file, rootPath)));
  const fromDisk = rootPath ? scanTaskHintFiles(rootPath) : [];
  return uniqueStrings([...fromCas, ...fromDisk]);
}

function scanTaskHintFiles(rootPath: string): string[] {
  if (!rootPath || !fs.existsSync(rootPath)) return [];
  const ignored = new Set(['.git', '.klauro', '.agents', '.claude', '.codex', 'node_modules', 'dist', 'build', 'target', 'coverage', '.next', '.turbo', '.cache', '.venv', 'venv', 'env']);
  const results: string[] = [];
  const visit = (directory: string) => {
    if (results.length >= 500) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= 500) return;
      const absolute = nodePath.join(directory, entry.name);
      const relative = nodePath.relative(rootPath, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name) && !entry.name.startsWith('.klauro')) visit(absolute);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|sql|md|mdx)$/.test(relative)) {
        results.push(relative);
      }
    }
  };
  visit(rootPath);
  return results;
}

function shouldIncludeTaskHintCandidate(file: string, tokens: Set<string>): boolean {
  const normalized = file.toLowerCase();
  if (isDocumentationPath(file)) {
    return targetLooksLikeDocumentationFirstWork([...tokens].join(' '));
  }
  if (/test|spec|__tests__/.test(normalized)) {
    return hasAny(tokens, ['test', 'tests', 'coverage', 'assert', 'regression', 'blank', 'visibility', 'archive']);
  }
  if (/migrations?\//.test(normalized)) {
    return hasAny(tokens, ['migration', 'schema', 'database', 'persisted', 'persistence', 'column', 'index']);
  }
  return !isNonProductSourceText(file);
}

function taskHintReadPlanItem(file: string, score: number): FileReadPlanItem {
  return {
    file,
    reason: `task hint related file (${score})`,
    node_ids: [],
    line_window: {
      start: 1,
      end: 220,
      instruction: `Read ${file} lines 1-220 if the selected target depends on this task-specific boundary.`,
    },
  };
}

function taskHintFileScore(file: string, tokens: Set<string>): number {
  const normalizedFile = file.toLowerCase();
  const fileTokens = tokenizeTaskHint(file);
  let score = 0;
  for (const token of tokens) {
    if (fileTokens.has(token)) score += token.length > 5 ? 8 : 4;
  }
  if (hasAny(tokens, ['tenant', 'workspace', 'scope', 'visibility', 'auth', 'role', 'authorization', 'authenticated']) && /policy|auth|guard|scope|session/.test(normalizedFile)) score += 20;
  if (hasAny(tokens, ['oidc', 'login', 'identity', 'token', 'session', 'password']) && /auth|oidc|identity|session|password|policy/.test(normalizedFile)) score += 24;
  if (hasAny(tokens, ['mfa', 'totp', 'challenge', 'step', 'login']) && /mfa|auth|session|challenge/.test(normalizedFile)) score += 26;
  if (hasAny(tokens, ['repository', 'data', 'persistence', 'batch', 'performance', 'n+1', 'slow']) && /repositor|dao|store|persistence/.test(normalizedFile)) score += 18;
  if (hasAny(tokens, ['controller', 'route', 'entry', 'refactor']) && /controller|route|handler/.test(normalizedFile)) score += 18;
  if (hasAny(tokens, ['service', 'validation', 'boundary', 'summary', 'performance', 'workflow']) && /service|usecase|workflow/.test(normalizedFile)) score += 14;
  if (hasAny(tokens, ['monolith', 'decompose', 'decomposition', 'split', 'extract']) && /module|controller|service|repositor|policy/.test(normalizedFile)) score += 24;
  if (hasAny(tokens, ['contract', 'dto', 'producer', 'consumer', 'client']) && /contract|dto|schema|client/.test(normalizedFile)) score += 24;
  if (hasAny(tokens, ['producer', 'route', 'api']) && /route|controller|handler|api/.test(normalizedFile)) score += 12;
  if (hasAny(tokens, ['consumer', 'client', 'render']) && /client|consumer|adapter/.test(normalizedFile)) score += 16;
  if (hasAny(tokens, ['test', 'tests', 'coverage', 'assert', 'regression']) && /test|spec|__tests__/.test(normalizedFile)) score += 18;
  if (hasAny(tokens, ['label', 'labels', 'task', 'due', 'archive', 'model', 'domain']) && /domain|model|entity|entities|schema|type/.test(normalizedFile)) score += 14;
  if (hasAny(tokens, ['audit', 'event', 'events']) && /audit|event|service|repositor|workflow/.test(normalizedFile)) score += 24;
  if (hasAny(tokens, ['migration', 'schema', 'database', 'persisted', 'persistence', 'column', 'index']) && /migrations?\//.test(normalizedFile)) score += 24;
  if (targetLooksLikeDocumentationFirstWork([...tokens].join(' ')) && isDocumentationPath(file)) score += 30;
  if (isDocumentationPath(file) && /docs?|readme|usage|guide|audit|proof|report|evidence/.test(normalizedFile)) score += 16;
  return score;
}

function targetLooksLikeDocumentationWork(text?: string): boolean {
  const tokens = tokenizeTaskHint(String(text || ''));
  return hasAny(tokens, ['doc', 'docs', 'documentation', 'readme', 'guide', 'usage', 'audit', 'proof', 'evidence', 'report']);
}

function targetLooksLikeDocumentationFirstWork(text?: string): boolean {
  const tokens = tokenizeTaskHint(String(text || ''));
  if (
    hasAny(tokens, ['inference', 'profile', 'domain', 'capability', 'entity', 'architecture', 'pattern', 'sdk', 'embedded', 'examples', 'monorepo', 'product', 'summary']) &&
    !hasAny(tokens, ['documentation', 'readme', 'guide', 'usage'])
  ) {
    return false;
  }
  return hasAny(tokens, ['doc', 'docs', 'documentation', 'readme', 'guide', 'usage', 'audit', 'proof', 'report']);
}

function isDocumentationPath(file: string): boolean {
  return /\.(md|mdx)$/i.test(file) || /(^|\/)(docs?|readme|guides?|reports?)(\/|$)/i.test(file);
}

function tokenizeTaskHint(text: string): Set<string> {
  return new Set(String(text || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9+]+/)
    .filter(token => token.length >= 3 && !TASK_HINT_STOP_WORDS.has(token)));
}

function hasAny(tokens: Set<string>, expected: string[]): boolean {
  return expected.some(token => tokens.has(token));
}

const TASK_HINT_STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'without',
  'that',
  'this',
  'into',
  'from',
  'before',
  'after',
  'while',
  'local',
  'existing',
  'minimal',
  'preserve',
  'change',
  'changes',
]);

function buildLineWindow(node: CASNode): FileReadPlanItem['line_window'] {
  const startLine = Math.max(1, node.source?.line || 1);
  const endLine = node.source?.end_line && node.source.end_line >= startLine
    ? node.source.end_line
    : startLine;
  const paddedStart = Math.max(1, startLine - 30);
  const naturalEnd = Math.max(paddedStart, endLine + 60);
  const paddedEnd = Math.min(naturalEnd, paddedStart + 180);
  return {
    start: paddedStart,
    end: paddedEnd,
    instruction: `Read ${node.source?.file || 'this file'} lines ${paddedStart}-${paddedEnd} first; expand only if the local context or tests require it.`,
  };
}

function handlerLineWindow(line?: number): FileReadPlanItem['line_window'] | undefined {
  if (!line || line < 1) return undefined;
  const start = Math.max(1, line - 30);
  const end = line + 60;
  return {
    start,
    end,
    instruction: `Read handler lines ${start}-${end} first; expand only if the entry-path context requires it.`,
  };
}

function suiteLineWindow(cas: CASOutput, file: string): FileReadPlanItem['line_window'] | undefined {
  const testNode = cas.nodes.find(node => node.source?.file && projectPathsMatch(node.source.file, file) && node.source.line);
  return testNode ? buildLineWindow(testNode) : undefined;
}

function isBehavioralReadPlanLink(via: string): boolean {
  const normalized = via.toLowerCase();
  return ![
    'edge:contains',
    'edge:provides',
    'edge:exports',
    'edge:has_method',
    'edge:has_property',
    'edge:declares',
    'edge:member_of',
  ].includes(normalized);
}

function buildValidationPlan(
  projectPath: string,
  cas: CASOutput,
  task: Required<Pick<AgentTask, 'task_type'>> & AgentTask,
  selectedNode: CASNode | undefined,
  tests: ReturnType<typeof findTests>,
  fileReadPlan: FileReadPlanItem[],
  risk: ReturnType<typeof assessChangeRisk> | null,
  behavioralInvariants: ReturnType<typeof getBehavioralInvariants>
): AgentValidationPlan {
  const testFiles = uniqueStrings([
    ...(tests.suites || []).map((suite: AgentTestSuiteRef) => suite.file_path).filter((file): file is string => Boolean(file)),
    ...fileReadPlan
      .filter(item => isTestPath(item.file))
      .map(item => item.file),
    ...inferLikelyFocusedTestFiles(projectPath, selectedNode, fileReadPlan),
  ].map(file => normalizeValidationFile(projectPath, file))).slice(0, 8);
  const commands: AgentValidationCommand[] = [];
  const scriptContexts = buildScriptContexts(projectPath, fileReadPlan, testFiles);
  for (const context of scriptContexts) {
    const focusedTestCommand = buildFocusedTestCommand(context.root, context.scripts, context.testFiles);
    if (focusedTestCommand) {
      addValidationCommand(commands, {
        command: commandForContext(projectPath, context.root, focusedTestCommand),
        purpose: context.testFiles.length > 0 ? 'Run tests that cover or sit next to the selected target.' : `Run the ${context.label} test script because no focused test file was resolved.`,
        scope: context.testFiles.length > 0 ? 'focused-test' : 'broad-test',
        files: context.displayTestFiles,
        confidence: context.testFiles.length > 0 ? 0.9 : context.root === projectPath ? 0.58 : 0.7,
      });
    }

    const typecheckCommand = buildScriptCommand(context.scripts, ['typecheck', 'type-check', 'check', 'tsc']);
    if (typecheckCommand && typecheckCommand !== focusedTestCommand) {
      addValidationCommand(commands, {
        command: commandForContext(projectPath, context.root, typecheckCommand),
        purpose: `Verify ${context.label} type contracts after the edit.`,
        scope: 'typecheck',
        confidence: 0.78,
      });
    }

    const buildCommand = buildScriptCommand(context.scripts, ['build']);
    if (buildCommand && task.task_type !== 'orient') {
      addValidationCommand(commands, {
        command: commandForContext(projectPath, context.root, buildCommand),
        purpose: `Verify the ${context.label} package still builds when touched files are compile-time sensitive.`,
        scope: 'build',
        confidence: 0.64,
      });
    }
  }

  const rootScripts = readPackageScripts(projectPath);
  if (commands.length === 0) {
    const focusedTestCommand = buildFocusedTestCommand(projectPath, rootScripts, testFiles);
    if (focusedTestCommand) {
      commands.push({
      command: focusedTestCommand,
      purpose: testFiles.length > 0 ? 'Run tests that cover or sit next to the selected target.' : 'Run the repository test script because no focused test file was resolved.',
      scope: testFiles.length > 0 ? 'focused-test' : 'broad-test',
      files: testFiles,
      confidence: testFiles.length > 0 ? 0.9 : 0.58,
      });
    }
  }

  const manualChecks = [
    selectedNode ? `Confirm the edit preserves the contract of ${selectedNode.name}.` : 'Confirm the edit target was resolved before changing source files.',
    selectedNode ? `After edits, call validate_behavioral_invariants for ${selectedNode.id}.` : 'After edits, call validate_behavioral_invariants with the task target or current working diff.',
    selectedNode ? `After edits, call validate_codebase_idioms for ${selectedNode.id}.` : 'After edits, call validate_codebase_idioms with the task target or current working diff.',
    ...(task.success_criteria || []).map(criterion => `Verify success criterion: ${criterion}`),
    ...(cas.codebase_idioms || []).slice(0, 5).map(idiom => `Preserve idiom: ${idiom.name} - ${idiom.agent_guidance.do[0] || idiom.description}`),
    ...behavioralInvariants.invariants.slice(0, 6).map((invariant: any) => `Preserve invariant: ${invariant.name} - ${invariant.description}`),
  ];
  const riskReasons = risk?.risk
    ? [
      risk.risk.risk_level ? `Risk level is ${risk.risk.risk_level}.` : '',
      ...(risk.risk.risk_factors || []).map(factor => `${factor.factor}: ${factor.details}`),
      ...(risk.risk.recommendations || []),
    ].filter(Boolean)
    : [];
  manualChecks.push(...riskReasons.slice(0, 4));

  const testsToInspect = testFiles.map(file => ({
    file,
    name: (tests.suites || []).find((suite: AgentTestSuiteRef) => suite.file_path === file)?.name,
    reason: 'Use this as the focused validation surface before broad test exploration.',
  }));

  return {
    strategy: testFiles.length > 0
      ? 'focused-tests-first'
      : commands.length > 0 ? 'repo-script-fallback' : 'manual-validation-required',
    commands: commands.slice(0, 4),
    tests_to_inspect: testsToInspect,
    manual_checks: uniqueStrings(manualChecks).slice(0, 10),
    run_policy: risk?.risk?.risk_level === 'high' || risk?.risk?.risk_level === 'critical'
      ? 'Run the focused validation once after all edits are complete, and rerun only the failing command after each fix. Change risk is elevated, so a final full focused pass is required before finishing.'
      : 'Run the focused validation once after all edits are complete; rerun only the failing command after a fix. Do not re-run passing suites between intermediate edits.',
    environment_rule: 'Do not install dependencies or run broad environment setup unless the task explicitly asks for it. If focused validation cannot run in the existing checkout, report that as an environment blocker.',
    gaps: commands.length === 0 ? ['no runnable validation command inferred from package scripts or test files'] : [],
  };
}

function inferLikelyFocusedTestFiles(projectPath: string, selectedNode: CASNode | undefined, fileReadPlan: FileReadPlanItem[]): string[] {
  const sourceFiles = uniqueStrings([
    selectedNode?.source?.file,
    ...fileReadPlan.map(item => item.file),
  ].filter((file): file is string => typeof file === 'string' && file.length > 0 && !isTestPath(file)));
  if (sourceFiles.length === 0) return [];

  const projectRoot = nodePath.resolve(projectPath);
  const roots = uniqueStrings(sourceFiles
    .map(file => findNearestPackageRoot(projectPath, file) || projectRoot)
    .filter(Boolean));
  const sourceProfiles = sourceFiles.map(file => sourceTestProfile(projectRoot, file, selectedNode?.name));
  const candidates = roots.flatMap(root => collectTestFileCandidates(root, projectRoot));
  const ranked = candidates
    .map(file => ({
      file,
      score: Math.max(...sourceProfiles.map(profile => scoreTestCandidate(projectRoot, file, profile))),
    }))
    .filter(item => item.score >= 5)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return uniqueStrings(ranked.map(item => item.file)).slice(0, 6);
}

interface SourceTestProfile {
  absolute: string;
  relative: string;
  stem: string;
  directory: string;
  symbols: string[];
  importNeedles: string[];
}

function sourceTestProfile(projectRoot: string, file: string, symbol?: string): SourceTestProfile {
  const absolute = nodePath.resolve(projectRoot, file);
  const relative = nodePath.relative(projectRoot, absolute).replace(/\\/g, '/');
  const stem = nodePath.basename(relative).replace(/\.(spec|test)\.[^.]+$/i, '').replace(/\.[^.]+$/i, '');
  const directory = nodePath.dirname(relative).replace(/\\/g, '/');
  const withoutExtension = relative.replace(/\.[^.]+$/i, '');
  return {
    absolute,
    relative,
    stem: stem.toLowerCase(),
    directory,
    symbols: uniqueStrings([symbol, pascalCaseFromStem(stem)].filter(Boolean) as string[]),
    importNeedles: uniqueStrings([
      withoutExtension,
      `/${withoutExtension}`,
      stem,
    ]),
  };
}

function scoreTestCandidate(projectRoot: string, testFile: string, source: SourceTestProfile): number {
  const absoluteTest = nodePath.resolve(projectRoot, testFile);
  const normalizedTest = testFile.replace(/\\/g, '/');
  const testDir = nodePath.dirname(normalizedTest).replace(/\\/g, '/');
  const testBase = nodePath.basename(normalizedTest).toLowerCase();
  let score = 0;
  if (testDir === source.directory && testBase.includes(source.stem)) score += 8;
  if (testBase.includes(source.stem)) score += 4;
  if (normalizedTest.toLowerCase().includes(`/${source.stem}.`)) score += 2;

  const content = readSmallTextFile(absoluteTest);
  if (content) {
    const lower = content.toLowerCase();
    if (lower.includes(source.stem)) score += 3;
    for (const symbol of source.symbols) {
      if (symbol && content.includes(symbol)) score += 6;
    }
    const relativeImport = nodePath.relative(nodePath.dirname(absoluteTest), source.absolute)
      .replace(/\\/g, '/')
      .replace(/\.[^.]+$/i, '');
    const importNeedles = uniqueStrings([
      relativeImport.startsWith('.') ? relativeImport : `./${relativeImport}`,
      ...source.importNeedles,
    ]);
    if (importNeedles.some(needle => needle && lower.includes(needle.toLowerCase()))) score += 7;
  }
  return score;
}

function collectTestFileCandidates(root: string, projectRoot: string): string[] {
  const candidates: string[] = [];
  const stack = [root];
  const maxCandidates = 800;
  while (stack.length > 0 && candidates.length < maxCandidates) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = nodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        if (isValidationSearchIgnoredDirectory(entry.name)) continue;
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = nodePath.relative(projectRoot, absolute).replace(/\\/g, '/');
      if (isTestPath(relative)) candidates.push(relative);
    }
  }
  return candidates;
}

function isValidationSearchIgnoredDirectory(name: string): boolean {
  return [
    '.git',
    '.klauro',
    '.next',
    '.turbo',
    'build',
    'coverage',
    'dist',
    'node_modules',
    'target',
  ].includes(name);
}

function readSmallTextFile(file: string): string {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 200_000) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function pascalCaseFromStem(stem: string): string {
  return stem
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
}

function readPackageScripts(projectPath: string): Record<string, string> {
  const packagePath = nodePath.join(projectPath, 'package.json');
  if (!fs.existsSync(packagePath)) return {};
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return pkg && typeof pkg === 'object' && pkg.scripts && typeof pkg.scripts === 'object'
      ? pkg.scripts
      : {};
  } catch {
    return {};
  }
}

function buildScriptContexts(projectPath: string, fileReadPlan: FileReadPlanItem[], testFiles: string[]) {
  const roots = new Set<string>();
  const addRootForFile = (file: string) => {
    const root = findNearestPackageRoot(projectPath, file);
    if (root) roots.add(root);
  };
  for (const item of fileReadPlan) addRootForFile(item.file);
  for (const file of testFiles) addRootForFile(file);
  if (fs.existsSync(nodePath.join(projectPath, 'package.json'))) roots.add(projectPath);

  return [...roots]
    .map(root => {
      const scripts = readPackageScripts(root);
      const relativeRoot = nodePath.relative(projectPath, root).replace(/\\/g, '/');
      const contextTestFiles = testFiles
        .filter(file => fileBelongsToRoot(projectPath, root, file))
        .map(file => normalizeValidationFile(root, nodePath.resolve(projectPath, file)));
      return {
        root,
        scripts,
        label: relativeRoot || 'repository',
        testFiles: contextTestFiles,
        displayTestFiles: contextTestFiles.map(file => relativeRoot ? `${relativeRoot}/${file}` : file),
      };
    })
    .filter(context => Object.keys(context.scripts).length > 0);
}

function findNearestPackageRoot(projectPath: string, file: string): string | null {
  const projectRoot = nodePath.resolve(projectPath);
  const absoluteFile = nodePath.resolve(projectRoot, file);
  let directory = fs.existsSync(absoluteFile) && fs.statSync(absoluteFile).isDirectory()
    ? absoluteFile
    : nodePath.dirname(absoluteFile);

  while (directory.startsWith(projectRoot)) {
    if (fs.existsSync(nodePath.join(directory, 'package.json'))) return directory;
    const parent = nodePath.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function fileBelongsToRoot(projectPath: string, root: string, file: string): boolean {
  const absoluteFile = nodePath.resolve(projectPath, file);
  const relative = nodePath.relative(root, absoluteFile);
  return Boolean(relative) && !relative.startsWith('..') && !nodePath.isAbsolute(relative);
}

function commandForContext(projectPath: string, root: string, command: string): string {
  const relativeRoot = nodePath.relative(projectPath, root).replace(/\\/g, '/');
  return relativeRoot ? `cd ${shellQuoteForAgent(relativeRoot)} && ${command}` : command;
}

function addValidationCommand(commands: AgentValidationCommand[], command: AgentValidationCommand): void {
  if (commands.some(existing => existing.command === command.command)) return;
  commands.push(command);
}

function buildFocusedTestCommand(projectPath: string, scripts: Record<string, string>, testFiles: string[]): string | null {
  if (testFiles.length === 0) {
    return buildScriptCommand(scripts, ['test']);
  }
  const quotedFiles = testFiles.map(shellQuoteForAgent).join(' ');
  const testScript = pickScript(scripts, ['test:unit', 'unit', 'test']);
  if (testScript) {
    return scriptCommand(testScript, true, quotedFiles);
  }
  const first = testFiles[0];
  if (first.endsWith('.py')) return `pytest ${quotedFiles}`;
  if (first.endsWith('.go')) return `go test ${uniqueGoPackages(projectPath, testFiles).join(' ')}`;
  if (first.endsWith('.rs')) return 'cargo test';
  if (first.match(/\.[cm]?[jt]sx?$/)) return `npm test -- ${quotedFiles}`;
  return null;
}

function buildScriptCommand(scripts: Record<string, string>, preferred: string[]): string | null {
  const script = pickScript(scripts, preferred);
  return script ? scriptCommand(script, false) : null;
}

function pickScript(scripts: Record<string, string>, preferred: string[]): string | null {
  for (const name of preferred) {
    if (scripts[name]) return name;
  }
  return null;
}

function scriptCommand(script: string, passFiles: boolean, files = ''): string {
  const base = script === 'test' ? 'npm test' : `npm run ${script}`;
  return passFiles ? `${base} -- ${files}` : base;
}

function uniqueGoPackages(projectPath: string, testFiles: string[]): string[] {
  return uniqueStrings(testFiles.map(file => {
    const directory = nodePath.dirname(nodePath.resolve(projectPath, file));
    const relative = nodePath.relative(projectPath, directory).replace(/\\/g, '/');
    return relative ? `./${relative}` : './...';
  }));
}

function shellQuoteForAgent(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeValidationFile(projectPath: string, file: string): string {
  const normalizedFile = file.replace(/\\/g, '/').replace(/^\.\//, '');
  const normalizedRoot = projectPath.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalizedFile.startsWith(`${normalizedRoot}/`)) {
    return normalizedFile.slice(normalizedRoot.length + 1);
  }
  return normalizedFile;
}

function isTestPath(file: string): boolean {
  return /(\.(spec|test)\.[cm]?[jt]sx?|(^|\/)test_[^/]+\.py$|_test\.(py|go|rs)|\.test\.py)$/i.test(file);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizeSourceFile(file: string, rootPath?: string): string {
  const normalizedFile = file.replace(/\\/g, '/');
  if (!rootPath) return normalizedFile.replace(/^\.\//, '');
  const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalizedFile.startsWith(`${normalizedRoot}/`)) {
    return normalizedFile.slice(normalizedRoot.length + 1);
  }
  return normalizedFile.replace(/^\.\//, '');
}

function inferRelatedTestSuites(cas: CASOutput, selectedNode?: CASNode): AgentTestSuiteRef[] {
  if (!selectedNode?.source?.file) return [];
  const rootPath = cas.system?.root_path;
  const sourceFile = normalizeSourceFile(selectedNode.source.file, rootPath);
  const sourceStem = pathStem(sourceFile);
  const colocatedCandidates = colocatedTestCandidates(sourceFile);

  return ((cas.test_suites || []) as AgentTestSuiteRef[]).filter(suite => {
    if (!suite.file_path) return false;
    const testFile = normalizeSourceFile(suite.file_path, rootPath);
    if (colocatedCandidates.some(candidate => projectPathsMatch(testFile, candidate))) return true;
    return Boolean(sourceStem && pathStem(testFile) === sourceStem);
  });
}

function uniqueTestSuites(suites: AgentTestSuiteRef[]): AgentTestSuiteRef[] {
  const seen = new Set<string>();
  const unique: AgentTestSuiteRef[] = [];
  for (const suite of suites) {
    const key = suite.file_path || suite.name;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(suite);
  }
  return unique;
}

function colocatedTestCandidates(sourceFile: string): string[] {
  const dir = sourceFile.includes('/') ? sourceFile.split('/').slice(0, -1).join('/') : '';
  const base = sourceFile.split('/').pop() || sourceFile;
  const stem = base.replace(/\.[^.]+$/, '');
  const pyCandidates = sourceFile.endsWith('.py')
    ? [
      sourceFile.replace(/\.py$/, '_test.py'),
      sourceFile.replace(/\.py$/, '.test.py'),
      dir ? `${dir}/test_${stem}.py` : `test_${stem}.py`,
      `tests/test_${stem}.py`,
      ...pythonApiTestCandidates(sourceFile),
    ]
    : [];
  return [
    sourceFile.replace(/\.([cm]?[jt]sx?)$/, '.spec.$1'),
    sourceFile.replace(/\.([cm]?[jt]sx?)$/, '.test.$1'),
    sourceFile.replace(/\.go$/, '_test.go'),
    sourceFile.replace(/\.rs$/, '_test.rs'),
    ...pyCandidates,
  ];
}

function pythonApiTestCandidates(sourceFile: string): string[] {
  const normalized = sourceFile.toLowerCase();
  if (!/(^|\/)(api|routes|views|controllers)(\/|$)/.test(normalized) && !/(^|\/)(app|main)\.py$/.test(normalized)) return [];
  return [
    'tests/test_api.py',
    'tests/test_app.py',
    'tests/test_routes.py',
  ];
}

function projectPathsMatch(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  const normalizedRight = right.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return normalizedLeft === normalizedRight || normalizedLeft.endsWith(`/${normalizedRight}`) || normalizedRight.endsWith(`/${normalizedLeft}`);
}

function pathStem(file: string): string {
  const base = file.split('/').pop() || file;
  return base
    .replace(/\.(spec|test)\.([cm]?[jt]sx?)$/i, '')
    .replace(/^test_/, '')
    .replace(/_test\.(py|go|rs)$/i, '')
    .replace(/\.test\.py$/i, '')
    .replace(/\.([cm]?[jt]sx?)$/i, '')
    .replace(/\.(py|go|rs)$/i, '')
    .toLowerCase();
}

function summarizeNodeForAgent(node: CASNode) {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    qualified_name: node.qualified_name,
    file: node.source?.file,
    line: node.source?.line,
    level: node.level,
    category: node.category,
    tags: node.tags,
  };
}

function workPacketTaskType(taskType?: AgentTaskType): 'add' | 'modify' | 'delete' | 'refactor' {
  if (taskType === 'review' || taskType === 'trace' || taskType === 'runtime' || taskType === 'cross-repo' || taskType === 'orient') return 'modify';
  if (taskType === 'debug') return 'modify';
  return 'modify';
}

export function evaluateAgentReadiness(cas: CASOutput, path: string, opts: { testEvidence?: TestDiscoveryEvidence } = {}): AgentReadinessReport {
  const summary = buildSummary(cas);
  const profile = classifyAnalysisProfile(cas, path);
  const answerPack = runAnswerPack(cas, path);
  const methodCalls = cas.method_calls?.length || cas.nodes.reduce((total, node) => total + (node.call_graph?.calls?.length || 0), 0);
  const tests = findTests(cas, { limit: 1 });
  const security = getSecurityOverview(cas);
  const flowCoverage = getFlowCoverage(cas) as Record<string, unknown>;
  const graphIntegrity = cas.validation?.graph_integrity;
  const runtimeLinks = cas.runtime_static_links?.length || 0;
  const facts = cas.analysis_facts?.length || 0;
  const idioms = cas.codebase_idioms?.length || 0;
  const analysisErrorEntries = cas.analysis_errors || [];
  const analysisErrors = analysisErrorEntries.filter(entry => (entry.severity ?? 'error') === 'error').length;
  const analysisWarningCount = analysisErrorEntries.length - analysisErrors;
  const testGate = testReadinessGate(tests.total_suites, opts.testEvidence);
  const invariantGapCount = cas.behavioral_invariant_summary?.gaps?.length || 0;
  const invariantGapSeverity = cas.behavioral_invariant_summary?.by_gap_severity || severityCounts(cas.behavioral_invariant_summary?.gaps || []);
  const blockingInvariantGaps = invariantGapSeverity.high || 0;
  const invariantGateStatus: GateStatus = (cas.behavioral_invariants?.length || 0) === 0
    ? 'warn'
    : blockingInvariantGaps > 0 ? 'warn' : 'pass';
  const invariantGateScore = (cas.behavioral_invariants?.length || 0) === 0
    ? 70
    : blockingInvariantGaps > 0 ? 86 : 100;
  const rawGates: AgentReadinessGate[] = [
    gate('analysis-errors', analysisErrors === 0 ? 'pass' : 'fail', analysisErrors === 0 ? 100 : 0, `${analysisErrors} analysis errors, ${analysisWarningCount} warnings`),
    gate('nodes', cas.nodes.length > 0 ? 'pass' : 'fail', cas.nodes.length > 0 ? 100 : 0, `${cas.nodes.length} nodes`),
    gate('edges', cas.edges.length > 0 ? 'pass' : 'fail', cas.edges.length > 0 ? 100 : 0, `${cas.edges.length} edges`),
    coverageGate('entry-points', cas.entry_points?.length || 0, minimumEntryPointCount(cas, profile)),
    coverageGate('call-chains', cas.call_chains?.length || 0, minimumCallChainCount(cas, profile)),
    relationshipDetailGate(cas, methodCalls, profile),
    gate('answer-pack', answerPack.gaps.length === 0 ? 'pass' : 'warn', answerPack.gaps.length === 0 ? 100 : 75, answerPack.gaps.length === 0 ? 'Mastery answer pack has no gaps' : answerPack.gaps.join('; ')),
    gate('evidence', facts > 0 ? 'pass' : 'warn', facts > 0 ? 100 : 75, `${facts} analysis facts`),
    gate('codebase-idioms', idioms > 0 ? 'pass' : 'warn', idioms > 0 ? 100 : 72, `${idioms} repo-local idioms`),
    gate(
      'behavioral-invariants',
      invariantGateStatus,
      invariantGateScore,
      (cas.behavioral_invariants?.length || 0) > 0
        ? `${cas.behavioral_invariants?.length || 0} behavior-level invariants, ${invariantGapCount} gaps (${invariantGapSeverity.high || 0} high, ${invariantGapSeverity.medium || 0} medium, ${invariantGapSeverity.low || 0} low)`
        : 'No behavior-level invariants inferred'
    ),
    testGate,
    gate('security', security.boundary_count > 0 || security.context_count > 0 ? 'pass' : 'warn', security.boundary_count > 0 || security.context_count > 0 ? 100 : 80, `${security.boundary_count || 0} boundaries, ${security.context_count || 0} contexts`),
    gate('runtime-correlation', runtimeLinks > 0 ? 'pass' : 'warn', runtimeLinks > 0 ? 100 : 80, `${runtimeLinks} runtime static links`),
    gate('flow-coverage', hasFlowCoverage(flowCoverage) ? 'pass' : 'warn', hasFlowCoverage(flowCoverage) ? 100 : 80, flowCoverageDetail(flowCoverage)),
  ];

  const dominantUnanalyzed = dominantUnanalyzedLanguage(cas);
  if (dominantUnanalyzed) {
    rawGates.push(gate(
      'language-coverage',
      dominantUnanalyzed.share_of_source >= 50 ? 'fail' : 'warn',
      Math.max(0, 100 - dominantUnanalyzed.share_of_source),
      `${dominantUnanalyzed.name} is ${dominantUnanalyzed.share_of_source}% of source but not analyzed; CAS covers only the analyzed remainder`
    ));
  }

  if (graphIntegrity) {
    const graphScore = normalizeScore(graphIntegrity.relationship_coverage_score);
    const danglingCoverage = graphIntegrity.total_edges <= 0 ? 100 : ((graphIntegrity.total_edges - graphIntegrity.dangling_edges) / graphIntegrity.total_edges) * 100;
    rawGates.push(gate(
      'graph-integrity',
      graphScore >= 85 && danglingCoverage >= 95 ? 'pass' : graphScore >= 70 && danglingCoverage >= 85 ? 'warn' : 'fail',
      Math.min(graphScore, danglingCoverage),
      `${graphIntegrity.connected_nodes} connected, ${graphIntegrity.orphaned_nodes} orphaned, ${graphIntegrity.dangling_edges} dangling`
    ));
    rawGates.push(gate(
      'entry-handler-coverage',
      cas.entry_points?.length ? statusForRatio(graphIntegrity.entry_points_with_handlers, cas.entry_points.length, 0.95, 0.8) : 'pass',
      ratioScore(graphIntegrity.entry_points_with_handlers, cas.entry_points?.length || 0),
      `${graphIntegrity.entry_points_with_handlers}/${cas.entry_points?.length || 0}`
    ));
    rawGates.push(gate(
      'exit-source-coverage',
      cas.exit_points?.length ? statusForRatio(graphIntegrity.exit_points_with_sources, cas.exit_points.length, 0.95, 0.8) : 'pass',
      ratioScore(graphIntegrity.exit_points_with_sources, cas.exit_points?.length || 0),
      `${graphIntegrity.exit_points_with_sources}/${cas.exit_points?.length || 0}`
    ));
  } else {
    rawGates.push(gate('graph-integrity', 'fail', 0, 'Missing validation.graph_integrity'));
  }

  const gates = rawGates.map(result => applyProfileExpectation(result, profile));
  const score = Math.round(gates.reduce((sum, result) => sum + result.score, 0) / gates.length);
  const rawStatus: GateStatus = gates.some(result => result.status === 'fail')
    ? 'fail'
    : gates.some(result => result.status === 'warn') ? 'warn' : 'pass';
  const adoptionGaps = gates
    .filter(result => result.status !== 'pass')
    .sort((left, right) => left.score - right.score)
    .slice(0, 8)
    .map(result => `${result.id}: ${result.detail}`);
  const defaultUseReady = analysisErrors === 0 && (rawStatus !== 'fail' ? score >= 85 : score >= 95);
  const status: GateStatus = rawStatus === 'fail' && defaultUseReady ? 'warn' : rawStatus;

  return {
    path,
    name: summary.name || path.split('/').pop() || path,
    generated_at: new Date().toISOString(),
    status,
    score,
    default_use: defaultUseReady,
    summary: {
      nodes: cas.nodes.length,
      edges: cas.edges.length,
      entry_points: cas.entry_points?.length || 0,
      exit_points: cas.exit_points?.length || 0,
      call_chains: cas.call_chains?.length || 0,
      method_calls: methodCalls,
      runtime_static_links: runtimeLinks,
      analysis_facts: facts,
      codebase_idioms: idioms,
      tests: tests.total_suites,
      analysis_errors: analysisErrors,
      behavioral_invariants: cas.behavioral_invariant_summary ? {
        total: cas.behavioral_invariant_summary.total,
        gaps: cas.behavioral_invariant_summary.gaps.length,
      } : undefined,
      test_discovery: opts.testEvidence ? {
        status: opts.testEvidence.status,
        source_test_files: opts.testEvidence.source_test_files,
        potential_uncovered_test_files: opts.testEvidence.potential_uncovered_test_files.length,
      } : undefined,
    },
    profile,
    gates,
    adoption_gaps: adoptionGaps,
    required_agent_behavior: [
      'Call get_agent_start_context before broad file reads when an analysis exists.',
      'Call open_agent_workbench for task-specific orientation, file-read plan, codebase rules, and evidence policy.',
      'Call get_agent_tool_plan for the user task before choosing MCP queries.',
      'Call preflight_agent_change before presenting multi-file plans, refactors, removals, or risky edits.',
      'Call get_coding_context before code edits in a targeted area.',
      'Use assess_change_risk and find_tests before landing changes that touch connected behavior.',
      'After edits, call validate_agent_change before finalizing.',
      'After edits, call validate_behavioral_invariants against the working diff before finalizing.',
      'After edits, call validate_codebase_idioms against the working diff before finalizing.',
      'Report CAS/MCP errors as blockers to default use and then fall back to direct code reading.',
    ],
    test_discovery: opts.testEvidence,
  };
}

function testReadinessGate(totalSuites: number, evidence?: TestDiscoveryEvidence): AgentReadinessGate {
  if (totalSuites > 0 && (!evidence || evidence.status === 'cas-covered')) {
    return gate('tests', 'pass', 100, `${totalSuites} test suites detected`);
  }
  if (totalSuites > 0 && evidence?.status === 'cas-partial') {
    return gate('tests', 'warn', 88, `${totalSuites} test suites detected; ${evidence.potential_uncovered_test_files.length} source test files are not represented in CAS`);
  }
  if (evidence?.status === 'potential-tests-missing-from-cas') {
    return gate('tests', 'warn', 65, `0 CAS test suites; ${evidence.source_test_files} source test files found but not represented in CAS`);
  }
  if (evidence?.status === 'no-source-tests-found') {
    return gate('tests', 'pass', 100, '0 CAS test suites; no source test files found in repository scan');
  }
  return gate('tests', 'warn', 80, `${totalSuites} test suites detected`);
}

function normalizeTask(task: AgentTask): Required<Pick<AgentTask, 'task_type'>> & AgentTask {
  return {
    ...task,
    task_type: task.task_type || 'orient',
  };
}

function stepsForTask(path: string, task: Required<Pick<AgentTask, 'task_type'>> & AgentTask, target: string, nodeId: string, entryPointId?: string, chainId?: string): AgentToolStep[] {
  const base: AgentToolStep[] = [
    step(1, 'get_agent_start_context', { path, task }, 'Load the CAS-backed default context and readiness status.', true),
    step(2, 'open_agent_workbench', { path, task }, 'Load the product-level workbench: file-read plan, repo rules, evidence policy, validation plan, and stop conditions.', true),
    step(3, 'get_agent_tool_plan', { path, task }, 'Select task-specific MCP calls before file reads.', true),
  ];

  if (task.task_type === 'modify') {
    return [
      ...base,
      step(4, 'search_nodes', { path, query: task.target || target, limit: 10 }, 'Resolve the target to a concrete CAS node.', true),
      step(5, 'preflight_agent_change', { path, target: task.target || target, task }, 'Check whether the proposed edit fits repo rules before editing or presenting a plan.', true),
      step(6, 'get_capability_memory', { path, target: task.target || target, instructions: task.instructions, success_criteria: task.success_criteria }, 'Check whether the requested behavior already exists before adding parallel code.', true),
      step(7, 'get_coding_context', { path, target, task_type: 'modify' }, 'Load conventions, connected code, and modification checklist.', true),
      step(8, 'assess_change_risk', { path, node_id: task.target ? '<node_id from search_nodes>' : nodeId }, 'Assess blast radius before editing.', true),
      step(9, 'find_tests', { path, node_id: task.target ? '<node_id from search_nodes>' : nodeId, limit: 10 }, 'Find direct test coverage and nearby tests.', true),
      step(10, 'get_codebase_idioms', { path, target: task.target ? '<node_id from search_nodes>' : nodeId, limit: 10 }, 'Check repo-local naming, placement, boundary, testing, and migration idioms before editing.', true),
      step(11, 'get_behavioral_invariants', { path, target: task.target ? '<node_id from search_nodes>' : nodeId, limit: 12 }, 'Check tenant/auth/schema/test invariants before editing.', true),
      step(12, 'get_callers', { path, node_id: task.target ? '<node_id from search_nodes>' : nodeId, depth: 2, limit: 25 }, 'Check upstream dependents.', false),
      step(13, 'get_callees', { path, node_id: task.target ? '<node_id from search_nodes>' : nodeId, depth: 2, limit: 25 }, 'Check downstream dependencies.', false),
      step(14, 'validate_agent_change', { path, target: task.target ? '<node_id from search_nodes>' : nodeId }, 'After edits, validate idioms, invariants, change shape, and finalization rules before finalizing.', true),
    ];
  }

  if (task.task_type === 'debug') {
    return [
      ...base,
      step(4, 'correlate_runtime_event', { path, event: task.runtime_event || { type: 'error', signal: task.target } }, 'Map runtime symptoms to CAS when an event or stack is available.', false),
      step(5, 'search_nodes', { path, query: task.target || target, limit: 10 }, 'Find likely code areas for the symptom.', true),
      step(6, 'get_error_contracts', { path, node_id: task.target ? '<node_id from search_nodes>' : nodeId, direction: 'both' }, 'Inspect error behavior and propagation.', false),
      step(7, 'get_call_chain', { path, entry_point_id: entryPointId, limit: 10 }, 'Trace the relevant behavior from entry point to exit.', false),
      step(8, 'preflight_agent_change', { path, target: task.target || target, task }, 'Check fix shape against repo rules before editing.', true),
      step(9, 'get_capability_memory', { path, target: task.target || target, instructions: task.instructions, success_criteria: task.success_criteria }, 'Check whether the bug overlaps existing behavior before adding another path.', true),
      step(10, 'get_coding_context', { path, target, task_type: 'modify' }, 'Load targeted context before changing code.', true),
      step(11, 'find_tests', { path, node_id: task.target ? '<node_id from search_nodes>' : nodeId, limit: 10 }, 'Find tests that should reproduce or guard the fix.', true),
      step(12, 'get_codebase_idioms', { path, target: task.target ? '<node_id from search_nodes>' : nodeId, limit: 10 }, 'Check repo-local idioms that the fix should preserve.', true),
      step(13, 'get_behavioral_invariants', { path, target: task.target ? '<node_id from search_nodes>' : nodeId, limit: 12 }, 'Check invariant rules that the bug fix must preserve.', true),
      step(14, 'validate_agent_change', { path, target: task.target ? '<node_id from search_nodes>' : nodeId }, 'After edits, validate idioms, invariants, change shape, and finalization rules before finalizing.', true),
    ];
  }

  if (task.task_type === 'review') {
    return [
      ...base,
      step(4, 'run_answer_pack', { path, pack: 'mastery' }, 'Verify the core explanations still answer cleanly.', true),
      step(5, 'get_change_summary', { path, group_by: 'file' }, 'Summarize recent CAS change history.', false),
      step(6, 'get_hot_spots', { path, limit: 20 }, 'Find risky churn areas.', false),
      step(7, 'get_flow_coverage', { path }, 'Check flow-level test protection.', true),
      step(8, 'get_security_overview', { path }, 'Review security boundaries and enforcement.', true),
      step(9, 'get_behavioral_invariants', { path, limit: 25 }, 'Review behavior-level invariant gaps.', true),
      step(10, 'get_codebase_idioms', { path, limit: 25 }, 'Review repo-local idioms and known deviations.', true),
      step(11, 'explain_change_shape', { path }, 'Map the reviewed diff to graph/test/idiom/invariant impact when local changes exist.', false),
      step(12, 'validate_agent_change', { path }, 'Validate current diff against idioms and invariants if reviewing local changes.', false),
    ];
  }

  if (task.task_type === 'trace') {
    return [
      ...base,
      step(3, 'get_entry_points', { path, limit: 20 }, 'Choose the behavior input to trace.', true),
      step(4, 'get_call_chain', { path, entry_point_id: entryPointId, chain_id: chainId, limit: 10 }, 'Trace from entry to downstream calls and exits.', true),
      step(5, 'get_exit_points', { path, limit: 20 }, 'Inspect external boundaries reached by the trace.', false),
      step(6, 'get_runtime_static_links', { path, limit: 20 }, 'Find runtime signals that can confirm the static trace.', false),
    ];
  }

  if (task.task_type === 'cross-repo') {
    return [
      ...base,
      step(3, 'list_analyses', {}, 'See which repositories already have CAS output.', true),
      step(4, 'get_cross_repo_links', { paths: [path, ...(task.related_paths || [])] }, 'Detect APIs, shared data stores, messages, and shared libraries across repos.', true),
      step(5, 'run_answer_pack', { path, pack: 'mastery' }, 'Explain the primary repo with evidence.', true),
    ];
  }

  if (task.task_type === 'runtime') {
    return [
      ...base,
      step(3, 'get_runtime_static_links', { path, limit: 25 }, 'List runtime signals and instrumentation candidates.', true),
      step(4, 'correlate_runtime_event', { path, event: task.runtime_event || { type: 'request', signal: task.target } }, 'Map runtime data back to CAS.', false),
      step(5, 'get_runtime_observations', { path, limit: 25 }, 'Read stored runtime observations and correlations.', false),
      step(6, 'run_answer_pack', { path, pack: 'mastery' }, 'Check whether runtime readiness remains explainable.', true),
    ];
  }

  return [
    ...base,
    step(3, 'run_answer_pack', { path, pack: 'mastery' }, 'Answer core codebase questions with evidence.', true),
    step(4, 'get_summary', { path }, 'Read condensed architecture and capability summary.', true),
    step(5, 'get_entry_points', { path, limit: 15 }, 'Inspect concrete inputs into the system.', false),
    step(6, 'get_flow_graph', { path }, 'Inspect capability-level behavior and dependencies.', false),
  ];
}

function step(order: number, tool: string, args: Record<string, unknown>, purpose: string, required: boolean): AgentToolStep {
  return { order, tool, args, purpose, required };
}

function severityCounts(gaps: Array<{ severity: 'high' | 'medium' | 'low' }>): Record<'high' | 'medium' | 'low', number> {
  return gaps.reduce((counts, gap) => {
    counts[gap.severity] = (counts[gap.severity] || 0) + 1;
    return counts;
  }, { high: 0, medium: 0, low: 0 } as Record<'high' | 'medium' | 'low', number>);
}

function gate(id: string, status: GateStatus, score: number, detail: string): AgentReadinessGate {
  return { id, status, score: Math.round(Math.max(0, Math.min(100, score))), detail };
}

export function dominantUnanalyzedLanguage(cas: CASOutput): { name: string; files: number; share_of_source: number } | null {
  const languages = cas.system?.technologies?.unanalyzed_languages || [];
  const dominant = [...languages]
    .filter(language => language.share_of_source >= 30)
    .sort((left, right) => right.share_of_source - left.share_of_source)[0];
  return dominant || null;
}

export function unanalyzedLanguageNote(cas: CASOutput): string | undefined {
  const dominant = dominantUnanalyzedLanguage(cas);
  if (!dominant) return undefined;
  return `${dominant.name} is ${dominant.share_of_source}% of source (${dominant.files} files) but not analyzed; CAS covers only the analyzed remainder. Fall back to direct file reading for the ${dominant.name} portion.`;
}

function coverageGate(id: string, actual: number, minimum: number): AgentReadinessGate {
  const score = ratioScore(actual, minimum);
  return gate(id, statusForScore(score), score, `${actual}/${minimum}`);
}

function relationshipDetailGate(cas: CASOutput, methodCalls: number, profile: AnalysisProfile): AgentReadinessGate {
  const callChains = cas.call_chains?.length || 0;
  const edges = cas.edges.length;
  const minimumMethodCalls = expectedMethodCallCount(profile, cas);
  if (minimumMethodCalls === 0) return gate('relationship-detail', 'pass', 100, 'Not applicable for this project kind');
  if (methodCalls >= minimumMethodCalls) return gate('relationship-detail', 'pass', 100, `${methodCalls} method calls`);
  if ((profile.kind === 'library-package' || profile.kind === 'test-package' || profile.kind === 'cli-tool') && edges > 0) {
    return gate('relationship-detail', 'warn', 92, `${methodCalls} method calls, ${callChains} call chains, ${edges} structural edges`);
  }
  if (callChains > 0 && edges > 0) {
    return gate('relationship-detail', 'warn', 90, `${methodCalls} method calls, ${callChains} call chains, ${edges} edges`);
  }
  return coverageGate('relationship-detail', methodCalls, minimumMethodCalls);
}

function ratioScore(actual: number, expected: number): number {
  if (expected <= 0) return 100;
  return Math.min(100, (actual / expected) * 100);
}

function statusForScore(score: number): GateStatus {
  if (score >= 100) return 'pass';
  if (score >= 70) return 'warn';
  return 'fail';
}

function statusForRatio(actual: number, expected: number, pass: number, warn: number): GateStatus {
  if (expected <= 0) return 'pass';
  const value = actual / expected;
  if (value >= pass) return 'pass';
  if (value >= warn) return 'warn';
  return 'fail';
}

function normalizeScore(value: number): number {
  return value > 1 ? Math.max(0, Math.min(100, value)) : Math.max(0, Math.min(100, value * 100));
}

function applyProfileExpectation(result: AgentReadinessGate, profile: AnalysisProfile): AgentReadinessGate {
  const expectation = gateExpectation(profile, result.id);
  if (expectation === 'not-applicable') {
    return gate(result.id, 'pass', 100, `Not applicable for ${profile.kind}; observed ${result.detail}`);
  }
  if (expectation === 'optional' && result.status !== 'pass') {
    return gate(result.id, 'pass', Math.max(90, result.score), `Optional for ${profile.kind}; observed ${result.detail}`);
  }
  return result;
}

function minimumEntryPointCount(cas: CASOutput, profile: AnalysisProfile): number {
  return expectedEntryPointCount(profile, cas);
}

function minimumCallChainCount(cas: CASOutput, profile: AnalysisProfile): number {
  return expectedCallChainCount(profile, cas);
}

function mostConnectedNodes(cas: CASOutput): CASNode[] {
  const counts = new Map<string, number>();
  for (const edge of cas.edges) {
    counts.set(edge.source, (counts.get(edge.source) || 0) + 1);
    counts.set(edge.target, (counts.get(edge.target) || 0) + 1);
  }
  for (const call of cas.method_calls || []) {
    if (call.caller_node) counts.set(call.caller_node, (counts.get(call.caller_node) || 0) + 1);
    if (call.target_node) counts.set(call.target_node, (counts.get(call.target_node) || 0) + 1);
  }

  return [...cas.nodes]
    .filter(node => node.type !== 'file' && node.type !== 'import' && !isSyntheticCallsiteNode(node))
    .sort((left, right) => (counts.get(right.id) || 0) - (counts.get(left.id) || 0));
}

function representativeTarget(cas: CASOutput): CASNode | undefined {
  return mostConnectedNodes(cas).find(node => !isNonProductAgentTarget(node)) ||
    cas.nodes.find(node => !isNonProductAgentTarget(node)) ||
    cas.nodes[0];
}

function representativeEntryPoint(cas: CASOutput): CASEntryPoint | undefined {
  const entries = cas.entry_points || [];
  return entries.find(entry => !isNonProductEntryPoint(cas, entry)) || entries[0];
}

function isNonProductEntryPoint(cas: CASOutput, entry: CASEntryPoint): boolean {
  if (entry.type === 'test') return true;
  if (isNonProductSourceText([entry.id, entry.name, entry.handler?.file].filter(Boolean).join('/'))) return true;
  const sourceNode = cas.nodes.find(node => node.id === entry.source_node);
  const handlerNode = entry.handler?.node_id
    ? cas.nodes.find(node => node.id === entry.handler?.node_id)
    : undefined;
  return Boolean(sourceNode && isNonProductAgentTarget(sourceNode)) ||
    Boolean(handlerNode && isNonProductAgentTarget(handlerNode));
}

function hasFlowCoverage(flowCoverage: Record<string, unknown>): boolean {
  const keys = Object.keys(flowCoverage);
  if (keys.length === 0) return false;
  return keys.some(key => {
    const value = flowCoverage[key];
    if (typeof value === 'number') return value > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return Boolean(value);
  });
}

function flowCoverageDetail(flowCoverage: Record<string, unknown>): string {
  const keys = Object.keys(flowCoverage);
  if (keys.length === 0) return 'No flow coverage summary';
  return keys.slice(0, 5).map(key => `${key}=${JSON.stringify(flowCoverage[key])}`).join(', ');
}
