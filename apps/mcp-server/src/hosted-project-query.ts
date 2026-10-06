import { constrainToInstalledTools } from './installed-tool-surface';
import { z } from 'zod';
import { FIND_TESTS_QUERY_SCHEMA } from './test-query-schema';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import type { RuntimeMetricLike } from '../../../packages/analyzer-core/src/analyzer/core/flow-concepts';
import * as agentAdoption from './agent-adoption';
import * as analysisMastery from './analysis-mastery';
import * as idiomQuery from './idiom-query';
import * as invariantValidation from './invariant-validation';
import * as query from './query';
import { buildAnswerPackDigest, runAnswerPack } from './product';
import { boundToolPayload } from './response-budget';
import type { CasSectionName } from './cas-sections';
import { HOSTED_SEARCH_NODES_SCHEMA } from './hosted-project-query-schema';

const taskSchema = z.object({
  task_type: z.enum(['orient', 'modify', 'debug', 'review', 'trace', 'cross-repo', 'runtime']).optional(),
  target: z.string().optional(),
  related_paths: z.array(z.string()).optional(),
  runtime_event: z.record(z.unknown()).optional(),
  instructions: z.string().optional(),
  success_criteria: z.array(z.string()).optional(),
  response_profile: z.enum(['standard', 'minimal', 'first-turn', 'capsule-only']).optional(),
  runtime: z.enum(['auto', 'include', 'exclude']).optional(),
  exclude_sections: z.array(z.string()).optional(),
}).strict();

const truthExpectationSchema = z.object({
  name: z.string().optional(),
  frameworks: z.array(z.string()).optional(),
  languages: z.array(z.string()).optional(),
  libraries: z.array(z.string()).optional(),
  routes: z.array(z.object({
    method: z.string().optional(), path: z.string(), handler: z.string().optional(), controller: z.string().optional(),
  }).strict()).optional(),
  nodes: z.array(z.object({ name: z.string(), type: z.string().optional(), file: z.string().optional() }).strict()).optional(),
  entities: z.array(z.string()).optional(),
  relationships: z.array(z.object({ source: z.string(), target: z.string(), type: z.string().optional() }).strict()).optional(),
  method_calls: z.array(z.object({
    caller: z.string(), target: z.string().optional(), method: z.string().optional(), resolution_type: z.string().optional(),
  }).strict()).optional(),
  exit_points: z.array(z.object({ type: z.string().optional(), name: z.string().optional(), target: z.string().optional() }).strict()).optional(),
  runtime_signals: z.array(z.string()).optional(),
  minimums: z.object({
    nodes: z.number().int().nonnegative().optional(),
    edges: z.number().int().nonnegative().optional(),
    entry_points: z.number().int().nonnegative().optional(),
    exit_points: z.number().int().nonnegative().optional(),
    method_calls: z.number().int().nonnegative().optional(),
    runtime_static_links: z.number().int().nonnegative().optional(),
    analysis_facts: z.number().int().nonnegative().optional(),
  }).strict().optional(),
}).strict();

export const HOSTED_PROJECT_QUERY_SCHEMAS = {
  get_agent_start_context: z.object({ task: taskSchema.optional() }).strict(),
  get_agent_tool_plan: z.object({ task: taskSchema.optional() }).strict(),
  get_agent_context: z.object({ task: taskSchema.optional() }).strict(),
  search_nodes: HOSTED_SEARCH_NODES_SCHEMA,
  get_coding_context: z.object({
    target: z.string().min(1), task_type: z.enum(['add', 'modify', 'delete', 'refactor']).optional(),
    include: z.array(z.string()).optional(), caller_limit: z.number().int().positive().max(500).optional(),
    callee_limit: z.number().int().positive().max(500).optional(),
  }).strict(),
  assess_change_risk: z.object({ node_id: z.string().min(1) }).strict(),
  find_tests: FIND_TESTS_QUERY_SCHEMA,
  get_product_map: z.object({}).strict(),
  get_user_journeys: z.object({
    journey_id: z.string().optional(), kind: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(), offset: z.number().int().nonnegative().optional(),
    format: z.enum(['json', 'markdown']).optional(), include_steps: z.boolean().optional(),
  }).strict(),
  get_codebase_idioms: z.object({
    category: z.enum(['naming', 'file-organization', 'module-boundary', 'dependency-injection', 'data-access', 'error-handling', 'validation', 'auth-tenant-scope', 'logging', 'testing', 'migrations', 'async-style', 'configuration']).optional(),
    target: z.string().optional(), min_confidence: z.number().min(0).max(1).optional(),
    limit: z.number().int().positive().max(200).optional(), offset: z.number().int().nonnegative().optional(),
  }).strict(),
  get_behavioral_invariants: z.object({
    invariant_type: z.enum(['tenant-scope', 'auth-boundary', 'authorization', 'db-constraint', 'migration-contract', 'test-coverage', 'data-lifecycle', 'business-rule']).optional(),
    target: z.string().optional(), limit: z.number().int().positive().max(200).optional(),
    offset: z.number().int().nonnegative().optional(),
  }).strict(),
  validate_codebase_idioms: z.object({
    target: z.string().optional(),
    category: z.enum(['naming', 'file-organization', 'module-boundary', 'dependency-injection', 'data-access', 'error-handling', 'validation', 'auth-tenant-scope', 'logging', 'testing', 'migrations', 'async-style', 'configuration']).optional(),
    files: z.array(z.string()).max(5000), diff_text: z.string().max(2_000_000),
    min_confidence: z.number().min(0).max(1).optional(), limit: z.number().int().positive().max(200).optional(),
  }).strict(),
  validate_behavioral_invariants: z.object({
    target: z.string().optional(),
    invariant_type: z.enum(['tenant-scope', 'auth-boundary', 'authorization', 'db-constraint', 'migration-contract', 'test-coverage', 'data-lifecycle', 'business-rule']).optional(),
    files: z.array(z.string()).max(5000), diff_text: z.string().max(2_000_000),
    limit: z.number().int().positive().max(200).optional(),
  }).strict(),
  run_answer_pack: z.object({
    pack: z.literal('mastery').optional(),
    section: z.enum(['overview', 'entry-points', 'representative-flow', 'change-impact', 'data', 'tests', 'external-boundaries', 'security', 'runtime-readiness']).optional(),
  }).strict(),
  get_module_health: z.object({
    kind: z.enum(['size-outlier', 'change-concentration', 'fan-in-hotspot', 'mixed-concerns', 'danger-composite']).optional(),
    severity: z.enum(['info', 'warning', 'error']).optional(),
    limit: z.number().int().positive().max(200).optional(), offset: z.number().int().nonnegative().optional(),
  }).strict(),
  evaluate_analysis_truth: z.object({ expectation: truthExpectationSchema.optional() }).strict(),
  get_semantic_map: z.object({
    target: z.string().optional(), limit: z.number().int().positive().max(200).optional(),
  }).strict(),
  get_framework_depth_report: z.object({}).strict(),
  get_runtime_instrumentation_plan: z.object({
    limit: z.number().int().positive().max(500).optional(),
  }).strict(),
  get_runtime_static_links: z.object({
    telemetry_status: z.string().optional(), kind: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(), offset: z.number().int().nonnegative().optional(),
  }).strict(),
  get_flow_graph: z.object({}).strict(),
  evaluate_agent_task_proof: z.object({ tasks: z.array(taskSchema).min(1).max(20).optional() }).strict(),
  evaluate_agent_readiness: z.object({}).strict(),
} as const;

export type HostedProjectQueryTool = keyof typeof HOSTED_PROJECT_QUERY_SCHEMAS;
export const HOSTED_PROJECT_QUERY_TOOL_NAMES = Object.freeze(
  Object.keys(HOSTED_PROJECT_QUERY_SCHEMAS) as HostedProjectQueryTool[]
);

const ORIENTATION_SECTIONS: readonly CasSectionName[] = [
  'facts', 'comprehension', 'tests', 'runtime', 'quality', 'supplemental',
];
const LIGHTWEIGHT_ANSWER_SECTIONS = [
  'entry-points', 'data', 'tests', 'external-boundaries', 'runtime-readiness',
] as const;

interface HostedQuerySectionArgs {
  node_id?: unknown;
  section?: unknown;
  include?: unknown;
  task?: { task_type?: unknown; target?: unknown; related_paths?: unknown[] };
}

function codingContextSections(include: unknown): readonly CasSectionName[] {
  const requested = Array.isArray(include) ? include.filter((item): item is string => typeof item === 'string') : [];
  const sections: CasSectionName[] = ['graph', 'quality', 'supplemental'];
  if (requested.length === 0 || requested.includes('tests')) sections.push('tests');
  return sections;
}

export function hostedProjectQuerySections(tool: string, args: HostedQuerySectionArgs = {}): readonly CasSectionName[] {
  switch (tool) {
    case 'search_nodes': return [];
    case 'get_product_map': return ['graph', 'calls', 'facts', 'comprehension', 'tests', 'runtime', 'quality', 'supplemental'];
    case 'get_user_journeys': return ['graph', 'calls', 'comprehension', 'tests', 'quality', 'supplemental'];
    case 'get_module_health': return ['quality'];
    case 'evaluate_analysis_truth': return ['graph', 'calls', 'facts', 'runtime', 'supplemental'];
    case 'get_semantic_map': return ['graph', 'calls', 'facts', 'supplemental'];
    case 'get_framework_depth_report': return ['graph', 'facts', 'runtime', 'supplemental'];
    case 'get_runtime_static_links': return ['facts', 'runtime'];
    case 'get_flow_graph': return ['comprehension', 'facts', 'runtime'];
    case 'get_runtime_instrumentation_plan': return ['graph', 'runtime'];
    case 'evaluate_agent_task_proof': return ['graph', 'calls', ...ORIENTATION_SECTIONS];
    case 'evaluate_agent_readiness': return ['graph', 'calls', ...ORIENTATION_SECTIONS];
    case 'get_codebase_idioms':
    case 'get_behavioral_invariants':
    case 'validate_codebase_idioms':
    case 'validate_behavioral_invariants': return ['quality'];
    case 'find_tests': return args.node_id ? ['graph', 'tests'] : ['tests'];
    case 'assess_change_risk': return ['graph', 'calls', 'tests', 'quality'];
    case 'get_coding_context': return codingContextSections(args.include);
    case 'get_agent_start_context':
    case 'get_agent_tool_plan': return ORIENTATION_SECTIONS;
    case 'get_agent_context': return !args.task?.target && !args.task?.related_paths?.length
      ? ORIENTATION_SECTIONS
      : ['graph', 'calls', ...ORIENTATION_SECTIONS];
    case 'run_answer_pack': {
      switch (args.section) {
        case 'representative-flow': return ['graph', 'calls', 'comprehension', 'supplemental'];
        case 'change-impact': return ['graph', 'calls', ...ORIENTATION_SECTIONS];
        case 'security': return ['graph', 'quality'];
        case 'overview': return ['graph', ...ORIENTATION_SECTIONS];
        case 'entry-points':
        case 'external-boundaries': return ['supplemental'];
        case 'data': return ['comprehension', 'quality', 'supplemental'];
        case 'tests': return ['comprehension', 'tests', 'quality'];
        case 'runtime-readiness': return ['facts', 'runtime'];
        default: return ORIENTATION_SECTIONS;
      }
    }
    default: throw new Error(`Unsupported hosted query tool: ${tool}`);
  }
}

export async function executeHostedProjectQuery(input: {
  cas: CASOutput;
  tool: string;
  args?: unknown;
  projectPath: string;
  runtimeMetrics?: RuntimeMetricLike[];
  observeUnbounded?: (tool: string, result: unknown) => void;
  transformUnbounded?: (tool: string, result: unknown) => unknown;
  deferBound?: boolean;
}): Promise<unknown> {
  if (!Object.prototype.hasOwnProperty.call(HOSTED_PROJECT_QUERY_SCHEMAS, input.tool)) {
    throw new Error(`Unsupported hosted query tool '${input.tool}'`);
  }
  const tool = input.tool as HostedProjectQueryTool;
  const args = HOSTED_PROJECT_QUERY_SCHEMAS[tool].parse(input.args ?? {}) as any;
  let result: unknown;

  switch (tool) {
    case 'get_agent_start_context':
      result = agentAdoption.getAgentStartContext(input.cas, input.projectPath, args.task || {});
      break;
    case 'get_agent_tool_plan':
      result = agentAdoption.getAgentToolPlan(input.cas, { path: input.projectPath, task: args.task || {} });
      break;
    case 'get_agent_context':
      result = await agentAdoption.getAgentContext(input.cas, input.projectPath, args.task || {});
      break;
    case 'search_nodes':
      result = query.searchNodes(input.cas, args.query, args);
      break;
    case 'get_coding_context':
      result = query.getCodingContext(input.cas, args.target, args);
      break;
    case 'assess_change_risk':
      result = query.assessChangeRisk(input.cas, args.node_id);
      break;
    case 'find_tests':
      result = query.findTests(input.cas, {
        nodeId: args.node_id, filePath: args.file_path, limit: args.limit, offset: args.offset,
        ...(args.suite_id ? { suiteId: args.suite_id } : {}),
      });
      break;
    case 'get_product_map':
      result = query.getProductMap(input.cas);
      break;
    case 'get_user_journeys':
      result = query.getUserJourneys(input.cas, {
        journeyId: args.journey_id, kind: args.kind, limit: args.limit, offset: args.offset,
        format: args.format, includeSteps: args.include_steps,
      });
      break;
    case 'get_codebase_idioms':
      result = idiomQuery.getCodebaseIdioms(input.cas, {
        category: args.category, target: args.target, minConfidence: args.min_confidence,
        limit: args.limit, offset: args.offset,
      });
      break;
    case 'get_behavioral_invariants':
      result = query.getBehavioralInvariants(input.cas, {
        invariantType: args.invariant_type, target: args.target, limit: args.limit, offset: args.offset,
      });
      break;
    case 'validate_codebase_idioms':
      result = idiomQuery.validateCodebaseIdioms(input.cas, input.projectPath, {
        target: args.target, category: args.category, files: args.files, diffText: args.diff_text,
        includeWorkingTree: false, allowFileReads: false, minConfidence: args.min_confidence, limit: args.limit,
      });
      break;
    case 'validate_behavioral_invariants':
      result = invariantValidation.validateBehavioralInvariants(input.cas, input.projectPath, {
        target: args.target, invariantType: args.invariant_type, files: args.files,
        diffText: args.diff_text, includeWorkingTree: false, limit: args.limit,
      });
      break;
    case 'run_answer_pack': {
      const answerPack = runAnswerPack(
        input.cas,
        input.projectPath,
        args.pack || 'mastery',
        args.section ? [args.section] : LIGHTWEIGHT_ANSWER_SECTIONS,
      );
      if (args.section) {
        const section = answerPack.answers.find(answer => answer.id === args.section);
        if (!section) throw new Error(`Unknown answer pack section '${args.section}'`);
        result = {
          pack: answerPack.pack,
          path: answerPack.path,
          generated_at: answerPack.generated_at,
          gaps: answerPack.gaps,
          section,
        };
      } else {
        result = buildAnswerPackDigest(answerPack, undefined, true);
      }
      break;
    }
    case 'get_module_health':
      result = query.getModuleHealth(input.cas, {
        kind: args.kind, severity: args.severity, limit: args.limit, offset: args.offset,
      });
      break;
    case 'evaluate_analysis_truth': {
      const expectation = args.expectation || await analysisMastery.loadTruthExpectation(input.projectPath);
      result = expectation
        ? analysisMastery.evaluateAnalysisTruth(input.cas, expectation)
        : { error: 'No expectation provided and no repo-local analysis expectation file found.' };
      break;
    }
    case 'get_semantic_map':
      result = analysisMastery.getSemanticMap(input.cas, { target: args.target, limit: args.limit });
      break;
    case 'get_framework_depth_report':
      result = analysisMastery.getFrameworkDepthReport(input.cas);
      break;
    case 'get_runtime_instrumentation_plan':
      result = analysisMastery.getRuntimeInstrumentationPlan(input.cas, { limit: args.limit });
      break;
    case 'get_runtime_static_links':
      result = query.getRuntimeStaticLinks(input.cas, {
        telemetryStatus: args.telemetry_status, kind: args.kind, limit: args.limit, offset: args.offset,
      }, input.runtimeMetrics || []);
      break;
    case 'get_flow_graph':
      result = query.getFlowGraph(input.cas, input.runtimeMetrics || []);
      break;
    case 'evaluate_agent_task_proof':
      result = await analysisMastery.evaluateAgentTaskProof(input.cas, input.projectPath, args.tasks || [{ task_type: 'orient' }]);
      break;
    case 'evaluate_agent_readiness':
      result = agentAdoption.evaluateAgentReadiness(input.cas, input.projectPath);
      break;
  }

  result = constrainToInstalledTools(result);
  if (input.transformUnbounded) result = input.transformUnbounded(tool, result);
  if (input.observeUnbounded) {
    try {
      input.observeUnbounded(tool, result);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ event: 'hosted_query_unbounded_observer_failed', tool, message: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
  if (input.deferBound) return result;
  return boundHostedProjectQueryResult(tool, args, result);
}

export function boundHostedProjectQueryResult(tool: HostedProjectQueryTool, args: Record<string, unknown>, result: unknown): unknown {
  return boundToolPayload(result, {
    tool,
    parameterNames: Object.keys(args),
  });
}
