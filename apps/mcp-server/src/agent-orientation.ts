import type { CASEntryPoint, CASNode, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { isInstalledToolName } from './installed-tool-registry';
import { projectEntryPointFlowsFromCas } from '../../../packages/analyzer-core/src/analyzer/core/entry-point-flow-projection';

interface OrientationTask {
  task_type?: string;
  target?: string;
}

interface ToolStep {
  order: number;
  tool: string;
  args: Record<string, unknown>;
  purpose: string;
  required: boolean;
}

const CRITICALITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function normalizeAgentToolSteps<T extends ToolStep>(steps: T[]): T[] {
  const seen = new Set<string>();
  const unique = steps.filter(step => {
    if (!step.tool || seen.has(step.tool)) return false;
    seen.add(step.tool);
    return true;
  });
  return unique
    .filter(step => isInstalledToolName(step.tool))
    .map((step, index) => ({ ...step, order: index + 1 }));
}

export function isTargetlessOrientationTask(task: OrientationTask): boolean {
  return task.task_type === 'orient' && !String(task.target || '').trim();
}

export function buildTargetlessOrientationContext(input: {
  path: string;
  task: OrientationTask;
  startContext: any;
  toolPlan: { steps?: ToolStep[] };
}): any {
  const start = input.startContext || {};
  const readinessGaps = Array.isArray(start.readiness?.gaps) ? start.readiness.gaps.slice(0, 5) : [];
  return {
    path: input.path,
    generated_at: new Date().toISOString(),
    task: input.task,
    status: start.readiness?.status === 'ready' ? 'ready' : 'needs-review',
    agent_context_ready: Boolean(start.readiness?.agent_context_ready),
    context_profile: 'read-only-orientation',
    readiness: start.readiness,
    system: start.system,
    product_orientation: start.product_orientation,
    scale: start.scale,
    starting_points: start.starting_points,
    target_resolution: { query: null, selected_node_id: null, selected_node: null, candidates: [], gaps: [] },
    selected_node: null,
    next_mcp_calls: (input.toolPlan.steps || []).map(step => ({
      order: step.order,
      tool: step.tool,
      purpose: step.purpose,
      required: step.required,
    })),
    source_reading_rule: 'Use product maps, conceptual analysis, entry-point flows, and answer packs first. Read source only when those comprehension surfaces report a concrete evidence gap.',
    gaps: readinessGaps,
  };
}

export function buildOrientationExecutionBrief(task: OrientationTask, fileReadPlan: any[]): any | null {
  if (task.task_type !== 'orient' || task.target) return null;
  const readFirst = [...new Set(fileReadPlan
    .map(item => String(item.file || '').trim())
    .filter(Boolean))]
    .slice(0, 5);
  return {
    mode: 'comprehension',
    task_type: 'orient',
    target: '',
    read_first: readFirst,
    edit_scope: [],
    validate: [],
    preserve: [],
    token_policy: {
      source_files: readFirst.length,
      final_response_words: 160,
      fallback: 'Expand into source only when product maps, concepts, journeys, or answer packs identify a concrete evidence gap.',
    },
    stop_rule: 'Stop after the product, architecture, and major journeys are explained with CAS evidence. Do not propose edits or tests unless requested.',
  };
}

export function buildOrientationValidationPlan(task: OrientationTask): Record<string, unknown> | null {
  if (task.task_type !== 'orient' || task.target) return null;
  return {
    strategy: 'comprehension-only',
    commands: [],
    tests_to_inspect: [],
    manual_checks: [],
    run_policy: 'No edit or test validation is required for codebase orientation.',
    environment_rule: 'Use CAS comprehension tools before targeted source reading.',
    gaps: [],
  };
}

export function orientationAnchorNodes(
  cas: CASOutput,
  connectedNodes: CASNode[],
  isExcludedNode: (node: CASNode) => boolean,
): CASNode[] {
  const nodeIndex = new Map(cas.nodes.map(node => [node.id, node]));
  const journeyNodeIds = projectEntryPointFlowsFromCas(cas).entryPointFlows
    .slice()
    .sort((left, right) =>
      journeyKindRank(left.flow_kind) - journeyKindRank(right.flow_kind) ||
      (CRITICALITY_RANK[left.criticality] ?? 4) - (CRITICALITY_RANK[right.criticality] ?? 4)
    )
    .flatMap(journey => [journey.entry?.handler_node_id, ...(journey.steps || []).map(step => step.node_id)])
    .filter((id): id is string => Boolean(id));
  const journeyNodes = journeyNodeIds
    .map(id => nodeIndex.get(id))
    .filter((node): node is CASNode => Boolean(node));
  const seen = new Set<string>();
  return [...journeyNodes, ...connectedNodes].filter(node => {
    if (seen.has(node.id) || isExcludedNode(node) || isOrientationSupportArtifact(node.source?.file || node.name)) return false;
    seen.add(node.id);
    return true;
  });
}

export function rankOrientationEntryPoints(
  cas: CASOutput,
  entries: CASEntryPoint[],
  isExcludedEntry: (entry: CASEntryPoint) => boolean,
): CASEntryPoint[] {
  const journeyRank = new Map<string, number>();
  for (const journey of projectEntryPointFlowsFromCas(cas).entryPointFlows) {
    const score = journeyKindRank(journey.flow_kind) * 100 + (CRITICALITY_RANK[journey.criticality] ?? 4) * 10;
    const current = journeyRank.get(journey.entry_point_id);
    if (current === undefined || score < current) journeyRank.set(journey.entry_point_id, score);
  }
  return entries
    .filter(entry => !isExcludedEntry(entry))
    .map((entry, index) => ({ entry, index, score: entryPointScore(entry, journeyRank.get(entry.id)) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(item => item.entry);
}

function journeyKindRank(kind: string): number {
  if (kind === 'user-facing') return 0;
  if (kind === 'system') return 1;
  return 2;
}

function entryPointScore(entry: CASEntryPoint, journeyScore?: number): number {
  const type = String(entry.type || '').toLowerCase();
  const text = [entry.id, entry.name, entry.handler?.file, entry.trigger?.path].filter(Boolean).join('/');
  let score = journeyScore === undefined ? 0 : 500 - journeyScore;
  if (['http', 'route', 'api', 'api_route', 'ui', 'page'].includes(type)) score += 180;
  else if (['event', 'message', 'webhook', 'lifecycle'].includes(type)) score += 100;
  else if (['cli', 'command'].includes(type)) score -= 40;
  if (isOrientationSupportArtifact(text)) score -= 300;
  return score;
}

function isOrientationSupportArtifact(value: string): boolean {
  const text = value.replace(/\\/g, '/').toLowerCase();
  return /(^|[/_.-])(benchmarks?|gauntlets?|parsers?|deploy(?:ment)?|migrations?|seeds?|fixtures?|scripts?)([/_.-]|$)/.test(text) ||
    /(^|[/_.-])(build|release|codegen|generated)([/_.-]|$)/.test(text);
}
