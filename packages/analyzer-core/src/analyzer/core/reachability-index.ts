/**
 * Reachability index (docs/SPEC-MATHEMATICAL-INTELLIGENCE.md, Workstream C).
 *
 * Answers "can A reach B along call edges" and "what is the affected
 * (upstream/downstream) set of A" in near-O(1) / O(answer) instead of a
 * per-query graph walk, at 50k-500k node scale. This is the standard
 * systemic alternative to the exhaustive-scan defect class: any consumer
 * that would otherwise re-scan the full edge list per query (the historical
 * instances: call-resolver quadratic fallback, telemetry CAS re-parse, WAS
 * lookup-map rebuild, partitioner one-hop edge scans) should consume this
 * index instead.
 *
 * Construction (build time, deterministic, pure):
 *   1. Tarjan SCC over the directed call graph, O(V+E), iterative (no
 *      recursion — real call graphs nest deep).
 *   2. Condensation DAG (components -> deduped comp edges, CSR form).
 *   3. Pruned 2-hop landmark labeling (PLL, Akiba et al.) over the
 *      condensation: for each component in descending-degree order, a pruned
 *      forward BFS adds it to the IN-label of everything it reaches and a
 *      pruned backward BFS adds it to the OUT-label of everything that
 *      reaches it. Query "a reaches b" = same component OR
 *      sortedIntersect(label_out(comp(a)), label_in(comp(b))).
 *
 * Determinism / byte-stability: node ids are sorted, edges deduped and
 * sorted, components renumbered by minimum member index, landmark order and
 * every emitted array are fully determined by the input set (not its
 * order) — building twice, or from a shuffled copy of the same graph,
 * yields byte-identical JSON. Tested.
 *
 * Persistence: the compact CSR shape (CASReachabilityIndex in cas.types.ts)
 * is stored on the CAS; ReachabilityIndex.from() rehydrates it for queries.
 * Enumeration queries (affected set) BFS over the condensation CSR — the
 * condensation is much smaller than the node graph and the walk is
 * O(answer), never O(V+E) re-scanned per query.
 *
 * Pure module: no IO, no storage, no AI — same discipline as
 * community-detection.ts.
 */

import type { CASReachabilityIndex } from '../../types/cas.types';
import { appendAll } from './bulk-array-ops';

export type { CASReachabilityIndex };

/** A directed call edge, caller -> callee. */
export type EdgePair = readonly [source: string, target: string];

export interface AffectedSetOptions {
  /**
   * 'upstream'  = nodes that can REACH the seeds (transitive callers — the
   *               blast radius / affected set when the seeds change),
   * 'downstream' = nodes the seeds can reach (transitive callees),
   * 'both'      = union (undirected closure), the partitioner's footprint
   *               semantics.
   * Default 'upstream'.
   */
  direction?: 'upstream' | 'downstream' | 'both';
  /** Stop expanding beyond this many result nodes (advisory bound; result is
   *  flagged truncated). Default Infinity. */
  maxNodes?: number;
  /** Bound the expansion to this many condensation hops from the seed set
   *  (depth 1 = direct neighbors). Default Infinity (full closure). */
  maxDepth?: number;
  /** Include the seed nodes themselves (and their SCC co-members) in the
   *  result. Default false — the result is "everything ELSE affected". */
  includeSeeds?: boolean;
}

export interface AffectedSetResult {
  affected: string[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Build the persistable index from a node-id set and directed call-edge
 * pairs. Edges whose endpoints are not in `nodeIds` are ignored; nodes with
 * no incident call edge are EXCLUDED from the index (they trivially reach
 * only themselves — callers must treat "not in index" as exactly that), which
 * keeps the stored size proportional to the call graph, not the whole CAS.
 */
export function buildReachabilityIndex(nodeIds: Iterable<string>, edges: Iterable<EdgePair>): CASReachabilityIndex {
  const inputIds = new Set(nodeIds);

  // Dedupe edges; keep only edges between known nodes; drop self-loops (they
  // do not change reachability).
  const edgeKeySet = new Set<string>();
  const cleanEdges: Array<[string, string]> = [];
  for (const [s, t] of edges) {
    if (s === t) continue;
    if (!inputIds.has(s) || !inputIds.has(t)) continue;
    const key = s + '\0' + t;
    if (edgeKeySet.has(key)) continue;
    edgeKeySet.add(key);
    cleanEdges.push([s, t]);
  }

  // Only nodes that participate in at least one call edge.
  const participating = new Set<string>();
  for (const [s, t] of cleanEdges) {
    participating.add(s);
    participating.add(t);
  }
  const node_ids = [...participating].sort();
  const indexOf = new Map<string, number>();
  node_ids.forEach((id, i) => indexOf.set(id, i));
  const n = node_ids.length;

  // Node-level adjacency (sorted for determinism).
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [s, t] of cleanEdges) adj[indexOf.get(s)!].push(indexOf.get(t)!);
  for (const list of adj) list.sort((a, b) => a - b);

  // --- 1. Tarjan SCC (iterative) -------------------------------------------
  const sccOf = new Int32Array(n).fill(-1);
  {
    const lowlink = new Int32Array(n);
    const disc = new Int32Array(n).fill(-1);
    const onStack = new Uint8Array(n);
    const stack: number[] = [];
    let timer = 0;
    let sccCount = 0;

    // Explicit DFS stack of [node, next-child-pointer].
    const frameNode: number[] = [];
    const frameChild: number[] = [];

    for (let root = 0; root < n; root++) {
      if (disc[root] !== -1) continue;
      frameNode.push(root);
      frameChild.push(0);
      while (frameNode.length > 0) {
        const v = frameNode[frameNode.length - 1];
        if (frameChild[frameChild.length - 1] === 0) {
          disc[v] = lowlink[v] = timer++;
          stack.push(v);
          onStack[v] = 1;
        }
        const ci = frameChild[frameChild.length - 1];
        if (ci < adj[v].length) {
          frameChild[frameChild.length - 1] = ci + 1;
          const w = adj[v][ci];
          if (disc[w] === -1) {
            frameNode.push(w);
            frameChild.push(0);
          } else if (onStack[w]) {
            if (disc[w] < lowlink[v]) lowlink[v] = disc[w];
          }
        } else {
          frameNode.pop();
          frameChild.pop();
          if (frameNode.length > 0) {
            const parent = frameNode[frameNode.length - 1];
            if (lowlink[v] < lowlink[parent]) lowlink[parent] = lowlink[v];
          }
          if (lowlink[v] === disc[v]) {
            // Root of an SCC — pop the component.
            while (true) {
              const w = stack.pop()!;
              onStack[w] = 0;
              sccOf[w] = sccCount;
              if (w === v) break;
            }
            sccCount++;
          }
        }
      }
    }

    // Canonical renumbering: order components by their minimum member index
    // so the numbering depends only on the graph, not on Tarjan visit order.
    const minMember = new Int32Array(sccCount).fill(n);
    for (let v = 0; v < n; v++) if (v < minMember[sccOf[v]]) minMember[sccOf[v]] = v;
    const order = Array.from({ length: sccCount }, (_, c) => c).sort((a, b) => minMember[a] - minMember[b]);
    const renumber = new Int32Array(sccCount);
    order.forEach((oldC, newC) => { renumber[oldC] = newC; });
    for (let v = 0; v < n; v++) sccOf[v] = renumber[sccOf[v]];
  }
  const compCount = n === 0 ? 0 : Math.max(...Array.from(sccOf)) + 1;

  // --- 2. Condensation DAG (CSR, deduped, sorted) ---------------------------
  const compAdjLists: number[][] = Array.from({ length: compCount }, () => []);
  {
    const seen = new Set<string>();
    for (let v = 0; v < n; v++) {
      const sc = sccOf[v];
      for (const w of adj[v]) {
        const tc = sccOf[w];
        if (sc === tc) continue;
        const key = sc + ',' + tc;
        if (seen.has(key)) continue;
        seen.add(key);
        compAdjLists[sc].push(tc);
      }
    }
  }
  for (const list of compAdjLists) list.sort((a, b) => a - b);
  const comp_adj_offsets = new Array<number>(compCount + 1);
  comp_adj_offsets[0] = 0;
  for (let c = 0; c < compCount; c++) comp_adj_offsets[c + 1] = comp_adj_offsets[c] + compAdjLists[c].length;
  const comp_adj_targets: number[] = [];
  for (const list of compAdjLists) appendAll(comp_adj_targets, list);

  // Reverse condensation adjacency (build-time only; derived again on load).
  const compRevLists: number[][] = Array.from({ length: compCount }, () => []);
  for (let c = 0; c < compCount; c++) for (const t of compAdjLists[c]) compRevLists[t].push(c);
  for (const list of compRevLists) list.sort((a, b) => a - b);

  // --- 3. Pruned landmark labeling over the condensation --------------------
  const labelOut: number[][] = Array.from({ length: compCount }, () => []); // landmarks L with L in out-label(c): c reaches... see query()
  const labelIn: number[][] = Array.from({ length: compCount }, () => []);

  // query(a,b) with labels built so far: a reaches b?
  const queryLabels = (a: number, b: number): boolean => {
    if (a === b) return true;
    const la = labelOut[a];
    const lb = labelIn[b];
    let i = 0;
    let j = 0;
    while (i < la.length && j < lb.length) {
      if (la[i] === lb[j]) return true;
      if (la[i] < lb[j]) i++; else j++;
    }
    return false;
  };

  // Landmark order: descending condensation degree (in+out), tie-break by
  // component id — high-degree hubs first prunes hardest (standard PLL).
  const degree = new Int32Array(compCount);
  for (let c = 0; c < compCount; c++) degree[c] = compAdjLists[c].length + compRevLists[c].length;
  const landmarkOrder = Array.from({ length: compCount }, (_, c) => c)
    .sort((a, b) => degree[b] - degree[a] || a - b);

  const bfsQueue = new Int32Array(compCount);
  const visited = new Uint8Array(compCount);
  const visitedList: number[] = [];

  const prunedBfs = (v: number, forward: boolean) => {
    let head = 0;
    let tail = 0;
    bfsQueue[tail++] = v;
    visited[v] = 1;
    visitedList.push(v);
    while (head < tail) {
      const u = bfsQueue[head++];
      // Prune: if existing labels already answer v->u (forward) / u->v
      // (backward), neither u nor anything beyond it needs this landmark.
      if (u !== v && (forward ? queryLabels(v, u) : queryLabels(u, v))) continue;
      if (forward) labelIn[u].push(v); else labelOut[u].push(v);
      const next = forward ? compAdjLists[u] : compRevLists[u];
      for (const w of next) {
        if (!visited[w]) {
          visited[w] = 1;
          visitedList.push(w);
          bfsQueue[tail++] = w;
        }
      }
    }
    for (const u of visitedList) visited[u] = 0;
    visitedList.length = 0;
  };

  for (const v of landmarkOrder) {
    prunedBfs(v, true);
    prunedBfs(v, false);
  }

  // Labels are appended in landmark order; sort ascending for the
  // merge-intersection in query() and for byte-stable output.
  for (const l of labelOut) l.sort((a, b) => a - b);
  for (const l of labelIn) l.sort((a, b) => a - b);

  const label_out_offsets = new Array<number>(compCount + 1);
  const label_in_offsets = new Array<number>(compCount + 1);
  label_out_offsets[0] = 0;
  label_in_offsets[0] = 0;
  const label_out: number[] = [];
  const label_in: number[] = [];
  for (let c = 0; c < compCount; c++) {
    appendAll(label_out, labelOut[c]);
    appendAll(label_in, labelIn[c]);
    label_out_offsets[c + 1] = label_out.length;
    label_in_offsets[c + 1] = label_in.length;
  }

  let largestScc = 0;
  {
    const size = new Int32Array(compCount);
    for (let v = 0; v < n; v++) size[sccOf[v]]++;
    for (let c = 0; c < compCount; c++) if (size[c] > largestScc) largestScc = size[c];
  }

  return {
    version: 1,
    node_ids,
    comp_of: Array.from(sccOf),
    comp_count: compCount,
    comp_adj_offsets,
    comp_adj_targets,
    label_out_offsets,
    label_out,
    label_in_offsets,
    label_in,
    stats: {
      nodes: n,
      edges: cleanEdges.length,
      comps: compCount,
      largest_scc: largestScc,
      label_entries: label_out.length + label_in.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Query wrapper
// ---------------------------------------------------------------------------

export class ReachabilityIndex {
  private readonly data: CASReachabilityIndex;
  private readonly indexOf = new Map<string, number>();
  /** comp -> member node indexes (derived on construction). */
  private readonly compMembers: number[][];
  /** Reverse condensation CSR (derived on construction). */
  private readonly revLists: number[][];

  private constructor(data: CASReachabilityIndex) {
    this.data = data;
    data.node_ids.forEach((id, i) => this.indexOf.set(id, i));
    this.compMembers = Array.from({ length: data.comp_count }, () => []);
    for (let v = 0; v < data.node_ids.length; v++) this.compMembers[data.comp_of[v]].push(v);
    this.revLists = Array.from({ length: data.comp_count }, () => []);
    for (let c = 0; c < data.comp_count; c++) {
      for (let k = data.comp_adj_offsets[c]; k < data.comp_adj_offsets[c + 1]; k++) {
        this.revLists[data.comp_adj_targets[k]].push(c);
      }
    }
  }

  static build(nodeIds: Iterable<string>, edges: Iterable<EdgePair>): ReachabilityIndex {
    return new ReachabilityIndex(buildReachabilityIndex(nodeIds, edges));
  }

  static from(persisted: CASReachabilityIndex): ReachabilityIndex {
    return new ReachabilityIndex(persisted);
  }

  /** The persistable form (the exact object this wrapper was built from). */
  toJSON(): CASReachabilityIndex {
    return this.data;
  }

  get stats(): CASReachabilityIndex['stats'] {
    return this.data.stats;
  }

  /** True when the node participates in the call graph this index covers. */
  has(nodeId: string): boolean {
    return this.indexOf.has(nodeId);
  }

  /**
   * Can `from` reach `to` along directed call edges (transitively)?
   * Nodes absent from the index reach only themselves.
   */
  canReach(from: string, to: string): boolean {
    if (from === to) return true;
    const a = this.indexOf.get(from);
    const b = this.indexOf.get(to);
    if (a === undefined || b === undefined) return false;
    const ca = this.data.comp_of[a];
    const cb = this.data.comp_of[b];
    if (ca === cb) return true;
    return this.intersects(
      this.data.label_out, this.data.label_out_offsets, ca,
      this.data.label_in, this.data.label_in_offsets, cb
    );
  }

  /**
   * The affected set of `seeds`: by default the UPSTREAM closure (every node
   * that can transitively reach a seed — i.e. everything whose behavior can
   * change when the seeds change). O(answer) — BFS over the condensation.
   */
  affectedSet(seeds: Iterable<string>, opts: AffectedSetOptions = {}): AffectedSetResult {
    const direction = opts.direction ?? 'upstream';
    const maxNodes = opts.maxNodes ?? Infinity;
    const maxDepth = opts.maxDepth ?? Infinity;
    const includeSeeds = opts.includeSeeds ?? false;

    const seedComps = new Set<number>();
    const seedNodeIdx = new Set<number>();
    for (const id of seeds) {
      const v = this.indexOf.get(id);
      if (v === undefined) continue;
      seedNodeIdx.add(v);
      seedComps.add(this.data.comp_of[v]);
    }

    // Frontier-at-depth BFS over the condensation. Seed components are
    // included in `reached` — their non-seed SCC co-members are affected
    // (mutual recursion with a changed node) even at depth 0.
    const visited = new Set<number>(seedComps);
    let frontier = [...seedComps].sort((a, b) => a - b);
    const reached: number[] = [...frontier];
    let affectedCount = 0;
    for (const c of frontier) affectedCount += this.compMembers[c].length;
    if (!includeSeeds) affectedCount -= seedNodeIdx.size;
    let truncated = affectedCount > maxNodes;

    for (let depth = 0; depth < maxDepth && frontier.length > 0 && !truncated; depth++) {
      const next: number[] = [];
      for (const c of frontier) {
        const neighbors = direction === 'downstream'
          ? this.forwardNeighbors(c)
          : direction === 'upstream'
            ? this.revLists[c]
            : [...this.forwardNeighbors(c), ...this.revLists[c]];
        for (const nc of neighbors) {
          if (visited.has(nc)) continue;
          if (affectedCount + this.compMembers[nc].length > maxNodes) {
            truncated = true;
            break;
          }
          visited.add(nc);
          next.push(nc);
          reached.push(nc);
          affectedCount += this.compMembers[nc].length;
        }
        if (truncated) break;
      }
      frontier = next.sort((a, b) => a - b);
    }
    if (frontier.length > 0 && !truncated) {
      // Depth bound stopped the walk — truncated only if the frontier still
      // had somewhere unvisited to go.
      for (const c of frontier) {
        const fwd = direction !== 'upstream' && this.forwardNeighbors(c).some((x) => !visited.has(x));
        const rev = direction !== 'downstream' && this.revLists[c].some((x) => !visited.has(x));
        if (fwd || rev) {
          truncated = true;
          break;
        }
      }
    }

    const affected: string[] = [];
    for (const c of reached) {
      for (const v of this.compMembers[c]) {
        if (!includeSeeds && seedNodeIdx.has(v)) continue;
        affected.push(this.data.node_ids[v]);
      }
    }
    affected.sort();
    return { affected: affected.slice(0, maxNodes === Infinity ? affected.length : maxNodes), truncated };
  }

  private forwardNeighbors(c: number): number[] {
    const { comp_adj_offsets, comp_adj_targets } = this.data;
    return comp_adj_targets.slice(comp_adj_offsets[c], comp_adj_offsets[c + 1]);
  }

  private intersects(
    la: number[], laOff: number[], a: number,
    lb: number[], lbOff: number[], b: number
  ): boolean {
    let i = laOff[a];
    const iEnd = laOff[a + 1];
    let j = lbOff[b];
    const jEnd = lbOff[b + 1];
    while (i < iEnd && j < jEnd) {
      if (la[i] === lb[j]) return true;
      if (la[i] < lb[j]) i++; else j++;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// CAS-shaped convenience: extract the directed call-edge pairs the index is
// defined over. Kept here (single definition) so build-time (orchestrator)
// and query-time fallback (apps/mcp-server/src/query.ts) use the SAME edge
// set — parity between index answers and traversal answers depends on it.
// ---------------------------------------------------------------------------

export interface CallGraphLikeCas {
  nodes: Array<{ id: string }>;
  edges: Array<{ source: string; target: string; type: string }>;
  method_calls?: Array<{ caller_node?: string; target_node?: string }>;
}

/** Directed caller->callee pairs: 'calls' edges plus resolved method_calls. */
export function callEdgePairs(cas: CallGraphLikeCas): EdgePair[] {
  const pairs: EdgePair[] = [];
  for (const e of cas.edges) {
    if (e.type === 'calls') pairs.push([e.source, e.target]);
  }
  for (const mc of cas.method_calls ?? []) {
    if (mc.caller_node && mc.target_node) pairs.push([mc.caller_node, mc.target_node]);
  }
  return pairs;
}

/**
 * Directed edges any reachability CLOSURE must follow: `callEdgePairs` PLUS
 * 'invokes' edges, which some analyzers emit for a dispatch/registration call
 * (e.g. a route table entry, an event-handler registration) rather than a
 * literal `calls` edge — a closure that stops at 'calls' silently loses those
 * dispatch-reached nodes. This is the edge set the PERSISTED
 * `cas.reachability_index` is built over (see buildReachabilityIndexFromCas)
 * and it is the single definition every consumer that follows or falls back
 * to that index must use identically: query.ts's traversal fallback and
 * deployable-analysis.ts's DAS closure both import this function rather than
 * re-deriving their own edge set, specifically so "index present" and "index
 * absent, fall back to traversal" never disagree (see
 * reachability-query.test.ts's parity proof).
 */
export function reachabilityEdgePairs(cas: CallGraphLikeCas): EdgePair[] {
  const pairs = callEdgePairs(cas);
  for (const e of cas.edges) {
    if (e.type === 'invokes') pairs.push([e.source, e.target]);
  }
  return pairs;
}

/** Build the persistable index straight from a CAS-shaped object. Uses
 *  `reachabilityEdgePairs` (calls + resolved method_calls + invokes) — see
 *  that function's doc comment for why 'invokes' is included and why every
 *  consumer of this persisted index must agree on the same edge set. Stamps
 *  `includes_invokes_edges: true` (see CASReachabilityIndex) so a consumer
 *  deciding whether to reuse this persisted index can tell it apart from one
 *  stored before 'invokes' was added to the closure — reuse must never be
 *  decided on presence alone, only on this flag. */
export function buildReachabilityIndexFromCas(cas: CallGraphLikeCas): CASReachabilityIndex {
  return { ...buildReachabilityIndex(cas.nodes.map((n) => n.id), reachabilityEdgePairs(cas)), includes_invokes_edges: true };
}
