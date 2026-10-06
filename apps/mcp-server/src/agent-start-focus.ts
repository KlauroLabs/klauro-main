import type { CASEntryPoint, CASExitPoint, CASNode, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { normalizeSourceFile } from './agent-source-paths';
import { searchNodes } from './query';

const NODES_PER_PATH = 8;
const TARGET_NODES = 6;
const TARGET_FLOWS = 4;
const TARGET_CAPABILITIES = 4;
const FOCUS_ENTRIES = 8;
const FOCUS_EXITS = 8;
const FOCUS_CONNECTED = 8;
const MIN_TOKEN_LENGTH = 3;

export interface FocusNodeRef {
  id: string;
  name: string;
  type: string;
  file?: string;
  line?: number;
}

export interface FocusPathResolution {
  path: string;
  status: 'in-analysis' | 'not-in-analysis';
  node_count: number;
  nodes: FocusNodeRef[];
  note?: string;
  local_git_status?: 'tracked' | 'untracked' | 'ignored' | 'missing-on-disk';
}

export interface StartFocus {
  status: 'resolved' | 'partially-resolved' | 'unresolved';
  related_paths: FocusPathResolution[];
  target: null | {
    query: string;
    capabilities: Array<{ id: string; name: string; matched_terms: string[] }>;
    flows: Array<{ flow_id: string; name: string; entry_point: string; capability_id?: string }>;
    nodes: FocusNodeRef[];
  };
  entry_points: Array<{ id: string; name: string; type: string; trigger: unknown; handler: unknown }>;
  exit_points: Array<{ id: string; name: string; type: string; source_node: string; target?: unknown }>;
  connected_nodes: FocusNodeRef[];
  gaps: string[];
}

export interface StartFocusTask {
  target?: string;
  related_paths?: string[];
}

const NOT_IN_ANALYSIS_NOTE =
  'Not in this analysis. The hosted analysis covers the committed snapshot of the repository, so a file that is untracked, ignored, or added after the analyzed commit has no nodes until it is committed and re-analyzed. Read it directly from disk.';

function tokensOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(token => token.length >= MIN_TOKEN_LENGTH);
}

function refOf(node: CASNode): FocusNodeRef {
  return { id: node.id, name: node.name, type: node.type, file: node.source?.file, line: node.source?.line };
}

function relativeTo(root: string | undefined, candidate: string): string {
  return normalizeSourceFile(candidate.trim(), root).replace(/\/+$/, '');
}

function resolvePath(cas: CASOutput, candidate: string): { resolution: FocusPathResolution; nodes: CASNode[] } {
  const root = cas.system?.root_path;
  const wanted = relativeTo(root, candidate);
  const held = cas.nodes.filter(node => {
    if (!node.source?.file) return false;
    const file = relativeTo(root, node.source.file);
    return file === wanted || file.startsWith(`${wanted}/`);
  });
  if (held.length === 0) {
    return { resolution: { path: candidate, status: 'not-in-analysis', node_count: 0, nodes: [], note: NOT_IN_ANALYSIS_NOTE }, nodes: [] };
  }
  const ranked = [...held].sort((left, right) => (left.level ?? 99) - (right.level ?? 99) || (left.source?.line ?? 0) - (right.source?.line ?? 0));
  return {
    resolution: { path: candidate, status: 'in-analysis', node_count: held.length, nodes: ranked.slice(0, NODES_PER_PATH).map(refOf) },
    nodes: held,
  };
}

function resolveTarget(cas: CASOutput, query: string) {
  const tokens = new Set(tokensOf(query));
  const overlap = (text: string) => tokensOf(text).filter(token => tokens.has(token));
  const capabilities = (cas.capabilities || [])
    .map(capability => ({ capability, terms: [...new Set(overlap(`${capability.name} ${capability.description ?? ''}`))] }))
    .filter(item => item.terms.length > 0)
    .sort((left, right) => right.terms.length - left.terms.length)
    .slice(0, TARGET_CAPABILITIES);
  const flows = (cas.flows || [])
    .map(flow => ({ flow, terms: overlap(`${flow.name} ${flow.intent ?? ''} ${flow.description ?? ''}`).length }))
    .filter(item => item.terms > 0)
    .sort((left, right) => right.terms - left.terms)
    .slice(0, TARGET_FLOWS)
    .map(item => item.flow);
  const nodeIds = searchNodes(cas, query, { limit: TARGET_NODES }).map(found => found.id);
  const byId = new Map(cas.nodes.map(node => [node.id, node]));
  return {
    capabilities: capabilities.map(item => ({ id: item.capability.id, name: item.capability.name, matched_terms: item.terms })),
    flows,
    nodes: nodeIds.map(id => byId.get(id)).filter((node): node is CASNode => node !== undefined),
  };
}

function entryNodeIds(entry: CASEntryPoint): string[] {
  return [entry.source_node, entry.handler?.node_id].filter((id): id is string => Boolean(id));
}

function connectedTo(cas: CASOutput, seed: Set<string>, nodes: Map<string, CASNode>): CASNode[] {
  const degree = new Map<string, number>();
  for (const edge of cas.edges) {
    const outward = seed.has(edge.source) && !seed.has(edge.target) ? edge.target : seed.has(edge.target) && !seed.has(edge.source) ? edge.source : null;
    if (outward) degree.set(outward, (degree.get(outward) ?? 0) + 1);
  }
  return [...degree.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([id]) => nodes.get(id))
    .filter((node): node is CASNode => node !== undefined)
    .slice(0, FOCUS_CONNECTED);
}

export function resolveStartFocus(cas: CASOutput, task: StartFocusTask): StartFocus | null {
  const query = (task.target || '').trim();
  const paths = [...new Set((task.related_paths || []).map(candidate => candidate.trim()).filter(Boolean))];
  if (!query && paths.length === 0) return null;

  const resolvedPaths = paths.map(candidate => resolvePath(cas, candidate));
  const target = query ? resolveTarget(cas, query) : null;
  const nodes = new Map(cas.nodes.map(node => [node.id, node]));
  const seed = new Set<string>([
    ...resolvedPaths.flatMap(item => item.nodes.map(node => node.id)),
    ...(target ? target.nodes.map(node => node.id) : []),
    ...(target ? target.flows.flatMap(flow => flow.steps.flatMap(step => step.functions.map(held => held.function_id))) : []),
  ]);
  const flowEntries = new Set((target?.flows ?? []).map(flow => flow.entry_point));

  const entryPoints = (cas.entry_points || [])
    .filter(entry => flowEntries.has(entry.id) || entryNodeIds(entry).some(id => seed.has(id)))
    .slice(0, FOCUS_ENTRIES);
  const exitPoints: CASExitPoint[] = (cas.exit_points || [])
    .filter(exit => seed.has(exit.source_node))
    .slice(0, FOCUS_EXITS);
  const connected = connectedTo(cas, seed, nodes);

  const gaps: string[] = [];
  const missing = resolvedPaths.filter(item => item.resolution.status === 'not-in-analysis');
  for (const item of missing) gaps.push(`${item.resolution.path}: ${NOT_IN_ANALYSIS_NOTE}`);
  const targetHit = target !== null && (target.capabilities.length > 0 || target.flows.length > 0 || target.nodes.length > 0);
  if (query && !targetHit) gaps.push(`target "${query}": no capability, flow, or node in the analysis matches it; search_nodes with narrower terms or read the related paths directly.`);

  const resolvedCount = resolvedPaths.length - missing.length + (targetHit ? 1 : 0);
  const asked = resolvedPaths.length + (query ? 1 : 0);
  return {
    status: resolvedCount === 0 ? 'unresolved' : resolvedCount < asked ? 'partially-resolved' : 'resolved',
    related_paths: resolvedPaths.map(item => item.resolution),
    target: target === null ? null : {
      query,
      capabilities: target.capabilities,
      flows: target.flows.map(flow => ({ flow_id: flow.flow_id, name: flow.name, entry_point: flow.entry_point, ...(flow.capability_id ? { capability_id: flow.capability_id } : {}) })),
      nodes: target.nodes.map(refOf),
    },
    entry_points: entryPoints.map(entry => ({ id: entry.id, name: entry.name, type: entry.type, trigger: entry.trigger, handler: entry.handler })),
    exit_points: exitPoints.map(exit => ({ id: exit.id, name: exit.name, type: exit.type, source_node: exit.source_node, target: exit.target })),
    connected_nodes: connected.map(refOf),
    gaps,
  };
}
