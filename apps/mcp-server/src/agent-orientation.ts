import type { CASEntryPoint, CASNode, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { isInstalledToolName } from './installed-tool-registry';

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

export function normalizeAgentToolSteps<T extends ToolStep>(steps: T[], task: OrientationTask): T[] {
  const seen = new Set<string>();
  const unique = steps.filter(step => {
    if (!step.tool || seen.has(step.tool)) return false;
    seen.add(step.tool);
    return true;
  });
  return (task.task_type === 'orient'
    ? unique.filter(step => isInstalledToolName(step.tool))
    : unique)
    .map((step, index) => ({ ...step, order: index + 1 }));
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
  const journeyNodeIds = (cas.user_journeys || [])
    .slice()
    .sort((left, right) =>
      journeyKindRank(left.journey_kind) - journeyKindRank(right.journey_kind) ||
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
  for (const journey of cas.user_journeys || []) {
    const score = journeyKindRank(journey.journey_kind) * 100 + (CRITICALITY_RANK[journey.criticality] ?? 4) * 10;
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
