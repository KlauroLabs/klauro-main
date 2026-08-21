import { z } from 'zod';
import type { CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import * as agentAdoption from './agent-adoption';
import * as idiomQuery from './idiom-query';
import * as invariantValidation from './invariant-validation';
import * as query from './query';
import { buildAnswerPackDigest, runAnswerPack } from './product';
import { boundToolPayload } from './response-budget';
import type { CasSectionName } from './cas-sections';

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

export const HOSTED_PROJECT_QUERY_SCHEMAS = {
  get_agent_start_context: z.object({ task: taskSchema.optional() }).strict(),
  get_agent_tool_plan: z.object({ task: taskSchema.optional() }).strict(),
  get_agent_context: z.object({ task: taskSchema.optional() }).strict(),
  search_nodes: z.object({
    query: z.string().min(1), type: z.string().optional(), file: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(), offset: z.number().int().nonnegative().optional(),
  }).strict(),
  get_coding_context: z.object({
    target: z.string().min(1), task_type: z.enum(['add', 'modify', 'delete', 'refactor']).optional(),
    include: z.array(z.string()).optional(), caller_limit: z.number().int().positive().max(500).optional(),
    callee_limit: z.number().int().positive().max(500).optional(),
  }).strict(),
  assess_change_risk: z.object({ node_id: z.string().min(1) }).strict(),
  find_tests: z.object({
    node_id: z.string().optional(), file_path: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(), offset: z.number().int().nonnegative().optional(),
  }).strict(),
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
} as const;

export type HostedProjectQueryTool = keyof typeof HOSTED_PROJECT_QUERY_SCHEMAS;
export const HOSTED_PROJECT_QUERY_TOOL_NAMES = Object.freeze(
  Object.keys(HOSTED_PROJECT_QUERY_SCHEMAS) as HostedProjectQueryTool[]
);

const ORIENTATION_SECTIONS: readonly CasSectionName[] = [
  'facts', 'comprehension', 'tests', 'runtime', 'quality', 'supplemental',
];

export function hostedProjectQuerySections(tool: string): readonly CasSectionName[] {
  switch (tool) {
    case 'search_nodes': return ['graph'];
    case 'get_product_map': return ['facts', 'comprehension', 'runtime', 'quality', 'supplemental'];
    case 'get_user_journeys': return ['comprehension'];
    case 'get_module_health': return ['graph', 'quality'];
    case 'get_codebase_idioms':
    case 'get_behavioral_invariants':
    case 'validate_codebase_idioms':
    case 'validate_behavioral_invariants': return ['quality'];
    case 'find_tests': return ['graph', 'calls', 'tests'];
    case 'assess_change_risk': return ['graph', 'calls', 'tests', 'quality'];
    case 'get_coding_context': return ['graph', 'calls', 'facts', 'comprehension', 'tests', 'quality', 'supplemental'];
    case 'get_agent_start_context':
    case 'get_agent_tool_plan': return ORIENTATION_SECTIONS;
    case 'get_agent_context':
    case 'run_answer_pack': return ['graph', 'calls', ...ORIENTATION_SECTIONS];
    default: throw new Error(`Unsupported hosted query tool: ${tool}`);
  }
}

export async function executeHostedProjectQuery(input: {
  cas: CASOutput;
  tool: string;
  args?: unknown;
  projectPath: string;
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
      const answerPack = runAnswerPack(input.cas, input.projectPath, args.pack || 'mastery');
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
        result = buildAnswerPackDigest(answerPack);
      }
      break;
    }
    case 'get_module_health':
      result = query.getModuleHealth(input.cas, {
        kind: args.kind, severity: args.severity, limit: args.limit, offset: args.offset,
      });
      break;
  }

  return boundToolPayload(result, {
    tool,
    parameterNames: Object.keys(args),
  });
}
