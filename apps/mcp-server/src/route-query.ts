import type { CASEdge, CASOutput } from '../../../packages/analyzer-core/src/types/cas.types';
import { getAffectedSet } from './query';
import { getQueryTraversalIndex, type QueryTraversalIndex } from './query-traversal-index';

const ROUTE_DEFAULT_MAX_DEPTH = 8;
const ROUTE_DEFAULT_MAX_PATHS = 3;
const ROUTE_EXPANSION_BUDGET = 50000;
const ROUTE_EDGE_TYPES = new Set(['calls', 'invokes']);
const CANDIDATE_LIMIT = 10;

export interface RouteOptions {
  maxDepth?: number;
  maxPaths?: number;
}

interface RouteRef {
  id: string;
  name: string;
  type: string;
  file?: string;
  line?: number;
}

export interface RouteHop {
  from: RouteRef;
  to: RouteRef;
  edge: string;
  via: 'structure' | 'name' | 'rule' | null;
  at?: { file?: string; line?: number };
}

interface Neighbor {
  id: string;
  edge: string;
  via: RouteHop['via'];
  at?: RouteHop['at'];
}

type Endpoint =
  | { ok: true; ids: string[]; kind: 'node' | 'step' | 'flow' | 'entry_point'; label: string }
  | { ok: false; error: string; candidates?: RouteRef[] };

function refOf(index: QueryTraversalIndex, id: string): RouteRef {
  const node = index.nodesById.get(id);
  return {
    id,
    name: node?.name ?? id,
    type: node?.type ?? 'unknown',
    ...(node?.source?.file === undefined ? {} : { file: node.source.file }),
    ...(node?.source?.line === undefined ? {} : { line: node.source.line }),
  };
}

function viaOf(edge: CASEdge, index: QueryTraversalIndex): RouteHop['via'] {
  const held = edge.metadata?.attributes?.via;
  if (held === 'name' || held === 'rule') return held;
  const source = index.nodesById.get(edge.source);
  return source?.primaryAnalyzer === 'tier-stack' ? 'structure' : null;
}

function locationOf(edge: CASEdge): RouteHop['at'] {
  const first = edge.metadata?.locations?.[0];
  return first === undefined ? undefined : { file: first.file, line: first.line };
}

function neighborsOf(index: QueryTraversalIndex, id: string, direction: 'out' | 'in'): Neighbor[] {
  const edges = direction === 'out' ? index.outgoingEdges : index.incomingEdges;
  const calls = direction === 'out' ? index.outgoingMethodCalls : index.incomingMethodCalls;
  const found = new Map<string, Neighbor>();
  for (const edge of edges.get(id) ?? []) {
    if (!ROUTE_EDGE_TYPES.has(edge.type)) continue;
    const other = direction === 'out' ? edge.target : edge.source;
    if (other === id || found.has(other)) continue;
    found.set(other, { id: other, edge: edge.type, via: viaOf(edge, index), at: locationOf(edge) });
  }
  for (const call of calls.get(id) ?? []) {
    const other = direction === 'out' ? call.target_node : call.caller_node;
    if (!other || other === id || found.has(other)) continue;
    found.set(other, { id: other, edge: 'method_call', via: null });
  }
  return [...found.values()];
}

function resolveRouteEndpoint(cas: CASOutput, index: QueryTraversalIndex, spec: string): Endpoint {
  const wanted = spec.trim();
  if (index.nodesById.has(wanted)) return { ok: true, ids: [wanted], kind: 'node', label: wanted };
  const entry = (cas.entry_points ?? []).find(point => point.id === wanted);
  if (entry !== undefined && index.nodesById.has(entry.source_node)) {
    return { ok: true, ids: [entry.source_node], kind: 'entry_point', label: wanted };
  }
  for (const flow of cas.flows ?? []) {
    const step = flow.steps.find(held => held.step_id === wanted);
    if (step !== undefined) {
      const ids = step.functions.map(held => held.function_id).filter(id => index.nodesById.has(id));
      if (ids.length > 0) return { ok: true, ids: [...new Set(ids)], kind: 'step', label: `${flow.name} / ${step.name}` };
    }
    if (flow.flow_id === wanted) {
      const handler = (cas.entry_points ?? []).find(point => point.id === flow.entry_point)?.source_node ?? flow.entry_point;
      const ids = [handler, ...flow.steps.flatMap(held => held.functions.map(fn => fn.function_id))]
        .filter(id => index.nodesById.has(id));
      if (ids.length > 0) return { ok: true, ids: [...new Set(ids)], kind: 'flow', label: flow.name };
    }
  }
  const named = cas.nodes.filter(node => node.name === wanted && node.type !== 'file');
  if (named.length === 1) return { ok: true, ids: [named[0].id], kind: 'node', label: named[0].id };
  if (named.length > 1) {
    return {
      ok: false,
      error: `"${wanted}" names ${named.length} nodes; pass one node id`,
      candidates: named.slice(0, CANDIDATE_LIMIT).map(node => refOf(index, node.id)),
    };
  }
  const tail = cas.nodes.filter(node => node.id.endsWith(`:${wanted}`) || node.id.includes(`:${wanted}:`));
  if (tail.length === 1) return { ok: true, ids: [tail[0].id], kind: 'node', label: tail[0].id };
  if (tail.length > 1) {
    return {
      ok: false,
      error: `"${wanted}" matches ${tail.length} node ids; pass one node id`,
      candidates: tail.slice(0, CANDIDATE_LIMIT).map(node => refOf(index, node.id)),
    };
  }
  return { ok: false, error: `"${wanted}" is not a node, step, flow or entry point in this analysis` };
}

function distancesToTargets(index: QueryTraversalIndex, targets: string[], maxDepth: number): Map<string, number> {
  const distance = new Map<string, number>(targets.map(id => [id, 0]));
  let frontier = [...targets];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of neighborsOf(index, id, 'in')) {
        if (distance.has(neighbor.id)) continue;
        distance.set(neighbor.id, depth);
        next.push(neighbor.id);
      }
    }
    frontier = next;
  }
  return distance;
}

interface Walk {
  nodes: string[];
  hops: Neighbor[];
}

function searchPaths(index: QueryTraversalIndex, sources: string[], targets: string[], maxDepth: number, maxPaths: number) {
  const targetSet = new Set(targets);
  const toTarget = distancesToTargets(index, targets, maxDepth);
  const found: Walk[] = [];
  let expansions = 0;
  let budgetSpent = false;
  const queue: Walk[] = [];
  for (const source of sources) {
    if (targetSet.has(source)) found.push({ nodes: [source], hops: [] });
    else if (toTarget.has(source)) queue.push({ nodes: [source], hops: [] });
  }
  for (let cursor = 0; cursor < queue.length && found.length <= maxPaths; cursor++) {
    const walk = queue[cursor];
    const last = walk.nodes[walk.nodes.length - 1];
    for (const neighbor of neighborsOf(index, last, 'out')) {
      if (walk.nodes.includes(neighbor.id)) continue;
      const length = walk.hops.length + 1;
      const left = toTarget.get(neighbor.id);
      if (left === undefined || length + left > maxDepth) continue;
      if (++expansions > ROUTE_EXPANSION_BUDGET) {
        budgetSpent = true;
        break;
      }
      const extended = { nodes: [...walk.nodes, neighbor.id], hops: [...walk.hops, neighbor] };
      if (targetSet.has(neighbor.id)) {
        found.push(extended);
        if (found.length > maxPaths) break;
      } else {
        queue.push(extended);
      }
    }
    if (budgetSpent) break;
  }
  const more = found.length > maxPaths;
  return { paths: found.slice(0, maxPaths), more, budgetSpent };
}

function hopsOf(index: QueryTraversalIndex, walk: Walk): RouteHop[] {
  return walk.hops.map((hop, at) => ({
    from: refOf(index, walk.nodes[at]),
    to: refOf(index, hop.id),
    edge: hop.edge,
    via: hop.via,
    ...(hop.at?.file === undefined && hop.at?.line === undefined ? {} : { at: hop.at }),
  }));
}

function reachedFrom(index: QueryTraversalIndex, sources: string[], maxDepth: number) {
  const depth = new Map<string, number>(sources.map(id => [id, 0]));
  let frontier = [...sources];
  let atBound = 0;
  for (let level = 1; level <= maxDepth && frontier.length > 0; level++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of neighborsOf(index, id, 'out')) {
        if (depth.has(neighbor.id)) continue;
        depth.set(neighbor.id, level);
        next.push(neighbor.id);
      }
    }
    frontier = next;
  }
  for (const id of frontier) {
    if (neighborsOf(index, id, 'out').some(neighbor => !depth.has(neighbor.id))) atBound++;
  }
  return { reached: depth, atBound };
}

function openFlowsThrough(cas: CASOutput, reached: Map<string, number>) {
  const handlers = new Map((cas.entry_points ?? []).map(point => [point.id, point.source_node]));
  const held: Array<{ flow_id: string; name: string; standing?: string; open?: number; cut?: boolean }> = [];
  for (const flow of cas.flows ?? []) {
    if (!(flow.open !== undefined && flow.open > 0) && flow.cut !== true && flow.standing !== 'open') continue;
    const ids = [handlers.get(flow.entry_point) ?? flow.entry_point, ...flow.steps.flatMap(step => step.functions.map(fn => fn.function_id))];
    if (!ids.some(id => reached.has(id))) continue;
    held.push({
      flow_id: flow.flow_id,
      name: flow.name,
      ...(flow.standing === undefined ? {} : { standing: flow.standing }),
      ...(flow.open === undefined ? {} : { open: flow.open }),
      ...(flow.cut === undefined ? {} : { cut: flow.cut }),
    });
  }
  return held;
}

function describeEnd(end: Endpoint & { ok: true }) {
  return { kind: end.kind, label: end.label, nodes: end.ids };
}

export function findRoutes(cas: CASOutput, fromSpec: string, toSpec: string, options: RouteOptions = {}) {
  const maxDepth = Math.max(1, Math.floor(options.maxDepth ?? ROUTE_DEFAULT_MAX_DEPTH));
  const maxPaths = Math.max(1, Math.floor(options.maxPaths ?? ROUTE_DEFAULT_MAX_PATHS));
  const index = getQueryTraversalIndex(cas);
  const from = resolveRouteEndpoint(cas, index, fromSpec);
  const to = resolveRouteEndpoint(cas, index, toSpec);
  if (!from.ok) return { found: false, error: from.error, side: 'from', candidates: from.candidates ?? [] };
  if (!to.ok) return { found: false, error: to.error, side: 'to', candidates: to.candidates ?? [] };
  const bound = { max_depth: maxDepth, max_paths: maxPaths, edge_types: [...ROUTE_EDGE_TYPES, 'method_call'] };
  const forward = searchPaths(index, from.ids, to.ids, maxDepth, maxPaths);
  const backward = forward.paths.length === 0 && !forward.budgetSpent
    ? searchPaths(index, to.ids, from.ids, maxDepth, maxPaths)
    : undefined;
  const chosen = forward.paths.length > 0 ? forward : backward !== undefined && backward.paths.length > 0 ? backward : undefined;
  if (chosen !== undefined) {
    const direction = chosen === forward ? 'forward' : 'reverse';
    const shortest = chosen.paths[0].hops.length;
    const truncated = chosen.more || chosen.budgetSpent;
    return {
      found: true,
      from: describeEnd(from),
      to: describeEnd(to),
      direction,
      paths: chosen.paths.map(walk => ({ length: walk.hops.length, hops: hopsOf(index, walk) })),
      bound: {
        ...bound,
        shortest_length: shortest,
        truncated,
        statement: `Searched calls up to ${maxDepth} hops, returning at most ${maxPaths} distinct paths shortest first; `
          + (truncated
            ? (chosen.budgetSpent
              ? 'the search stopped at its work limit, so further paths may exist.'
              : 'more paths exist than were returned.')
            : `these are all the paths within ${maxDepth} hops.`)
          + (direction === 'reverse' ? ` No path leads from the first to the second; these paths run from the second to the first.` : ''),
      },
    };
  }
  const { reached, atBound } = reachedFrom(index, from.ids, maxDepth);
  const openFlows = openFlowsThrough(cas, reached);
  const beyond = forward.budgetSpent ? false : getAffectedSet(cas, from.ids, { direction: 'downstream' })
    .affected.some(id => to.ids.includes(id));
  const reason = forward.budgetSpent
    ? 'search_limit'
    : beyond
      ? 'beyond_depth_bound'
      : openFlows.length > 0
        ? 'open_end'
        : 'disconnected_within_analysis';
  const statements: Record<string, string> = {
    search_limit: `The search stopped at its work limit before finding a path within ${maxDepth} hops; no conclusion about connectivity.`,
    beyond_depth_bound: `A path exists but is longer than ${maxDepth} hops; raise max_depth.`,
    open_end: `No path within ${maxDepth} hops. ${openFlows.length} flow(s) running through the code reached from the start end in calls the analysis could not resolve or were cut short, so a connection through that unresolved code cannot be ruled out.`,
    disconnected_within_analysis: `No path in either direction within ${maxDepth} hops, and every call out of the code reached from the start was followed to its end; the two are disconnected in this analysis.`,
  };
  return {
    found: false,
    from: describeEnd(from),
    to: describeEnd(to),
    paths: [],
    bound: { ...bound, truncated: forward.budgetSpent, searched_both_directions: backward !== undefined },
    no_path: {
      reason,
      statement: statements[reason],
      reached_from_start: reached.size,
      frontier_at_depth_bound: atBound,
      open_flows: openFlows,
    },
  };
}

export type RouteResult = ReturnType<typeof findRoutes>;
