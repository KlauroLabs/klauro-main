/**
 * Structural Importance — deterministic per-node importance over the stored
 * call graph (docs/SPEC-MATHEMATICAL-INTELLIGENCE.md, Workstream A).
 *
 * Seeded random-walk centrality via power iteration (implementation citation:
 * personalized PageRank-style formulation — the citation stays here; every
 * product/API/CAS-facing name is "structural importance"). A node's score is
 * the stationary probability that a random walk restarting at the NON-TEST
 * entry points of the system lands on it — mass flows from real product
 * entrances through the call graph, so a deep pipeline accumulates weight a
 * dead-end UI event handler never does.
 *
 * CONSTRAINTS (all load-bearing):
 * - Deterministic layer, never AI-derived: same CAS revision → byte-identical
 *   scores. Node order is fixed (lexicographic id sort), no Math.random, no
 *   timestamps, scores rounded to a fixed precision before storage.
 * - Seed filtering is MANDATORY: on the self-CAS 88% of entry points are
 *   test-kind; seeding uniformly over all entry points would rank test
 *   scaffolding as the system core. Seeds exclude `type === 'test'` entry
 *   points, nodes flagged `metadata.is_test`, and nodes whose source file is
 *   scaffold/test-path shaped (scaffold-paths.ts predicate).
 * - Additive: this module reads nodes/edges/entry points and returns scores;
 *   it must never add, remove, or retype any of them (parity invariant).
 * - Complexity O(maxIterations × E): ≤ 150 × 62k ≈ 9.3M edge-ops on the
 *   self-CAS (sub-second). Bound for very large graphs: at 500k edges the
 *   worst case is ~75M edge-ops — single-digit seconds, still linear in E;
 *   convergence typically lands far below maxIterations on sparse call DAGs.
 */

import { CASEdge, CASEntryPoint, CASNode, CASStructuralImportanceMeta } from '../../types/cas.types';
import { isScaffoldOrTestPath } from './scaffold-paths';

/** Call-ish edge types — same predicate family as call-graph-builder.ts
 *  isCallEdge, so importance flows over the graph agents actually traverse. */
const CALLISH_EDGE_TYPES = new Set([
  'calls', 'uses', 'depends_on', 'invokes', 'delegates_to', 'maps_to', 'queries', 'wraps',
]);

export interface StructuralImportanceOptions {
  /** Continuation probability of the walk (restart = 1 - damping). */
  damping?: number;
  /** L1 convergence threshold between iterations. */
  epsilon?: number;
  /** Hard iteration cap when convergence is slow. */
  maxIterations?: number;
}

/** Meta shape is the CAS-stored provenance block — single source of truth in
 *  cas.types.ts so the module and the schema can never drift. */
export type StructuralImportanceMeta = CASStructuralImportanceMeta;

export interface StructuralImportanceResult {
  /** Normalized [0,1] per node id: 1 = highest-importance node in this graph.
   *  Rounded to 8 decimals for byte-stable serialization. */
  scores: Map<string, number>;
  meta: StructuralImportanceMeta;
}

const DEFAULT_DAMPING = 0.85;
const DEFAULT_EPSILON = 1e-8;
// The walk contracts by ~damping per iteration, so L1 < 1e-8 needs up to
// ceil(ln(1e-8)/ln(0.85)) ≈ 114 iterations on worst-case chain shapes — a
// 100-iteration cap would report converged=false while epsilon is reachable.
const DEFAULT_MAX_ITERATIONS = 150;
const SCORE_DECIMALS = 8;

type SeedableNode = Pick<CASNode, 'id' | 'source' | 'metadata'>;

/** True when this entry point may seed the walk: not test-kind. The node-level
 *  test/scaffold checks are applied against the resolved node separately. */
function isSeedableEntryPoint(entryPoint: CASEntryPoint): boolean {
  return entryPoint.type !== 'test';
}

/** True when the node itself is test/scaffold shaped and must not seed. */
function isTestShapedNode(node: SeedableNode | undefined): boolean {
  if (!node) return true;
  if (node.metadata?.is_test === true) return true;
  const file = node.source?.file;
  if (file && isScaffoldOrTestPath(file)) return true;
  return false;
}

/**
 * Resolve the seed node-id set from entry points: for every non-test entry
 * point, its handler node and its source node — kept only when the node
 * exists in the graph and is not test/scaffold shaped.
 */
export function resolveSeedNodeIds(
  entryPoints: CASEntryPoint[],
  nodesById: Map<string, SeedableNode>
): string[] {
  const seeds = new Set<string>();
  for (const entryPoint of entryPoints) {
    if (!isSeedableEntryPoint(entryPoint)) continue;
    const candidates = [entryPoint.handler?.node_id, entryPoint.source_node];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const node = nodesById.get(candidate);
      if (!node || isTestShapedNode(node)) continue;
      seeds.add(candidate);
    }
  }
  return [...seeds].sort();
}

/**
 * Compute structural importance for every node. Pure and deterministic:
 * output depends only on (nodes, edges, entryPoints, options).
 */
export function computeStructuralImportance(
  nodes: SeedableNode[],
  edges: CASEdge[],
  entryPoints: CASEntryPoint[],
  options: StructuralImportanceOptions = {}
): StructuralImportanceResult {
  const damping = options.damping ?? DEFAULT_DAMPING;
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  // Fixed iteration order: lexicographic node-id sort — the determinism anchor.
  const orderedIds = nodes.map(n => n.id).sort();
  const indexById = new Map<string, number>();
  orderedIds.forEach((id, index) => indexById.set(id, index));
  const n = orderedIds.length;

  const nodesById = new Map<string, SeedableNode>();
  for (const node of nodes) nodesById.set(node.id, node);

  const emptyMeta = (edgeCount: number, seedCount: number, seedSource: 'entry-points' | 'uniform'): StructuralImportanceMeta => ({
    algorithm: 'seeded-random-walk-power-iteration',
    damping,
    epsilon,
    max_iterations: maxIterations,
    iterations: 0,
    converged: true,
    seed_count: seedCount,
    seed_source: seedSource,
    node_count: n,
    edge_count: edgeCount,
  });

  if (n === 0) {
    return { scores: new Map(), meta: emptyMeta(0, 0, 'uniform') };
  }

  // Call-ish edges, deduplicated per (source, target) so duplicate typed edges
  // between one pair do not double an arc's weight; endpoints must both exist.
  const seenArcs = new Set<string>();
  const outTargets: number[][] = Array.from({ length: n }, () => []);
  let edgeCount = 0;
  for (const edge of edges) {
    if (!CALLISH_EDGE_TYPES.has(edge.type)) continue;
    if (edge.source === edge.target) continue;
    const sourceIndex = indexById.get(edge.source);
    const targetIndex = indexById.get(edge.target);
    if (sourceIndex === undefined || targetIndex === undefined) continue;
    const arcKey = `${sourceIndex}:${targetIndex}`;
    if (seenArcs.has(arcKey)) continue;
    seenArcs.add(arcKey);
    outTargets[sourceIndex].push(targetIndex);
    edgeCount++;
  }
  // Per-source target order must be deterministic regardless of edges[] order.
  for (const targets of outTargets) targets.sort((a, b) => a - b);

  // Seed (restart) distribution: uniform over non-test entry-point nodes;
  // uniform over all nodes only when no eligible seed exists (a library with
  // no product entry points still gets a meaningful ranking).
  const seedIds = resolveSeedNodeIds(entryPoints, nodesById);
  const seedSource: 'entry-points' | 'uniform' = seedIds.length > 0 ? 'entry-points' : 'uniform';
  const seedIndexes = seedSource === 'entry-points'
    ? seedIds.map(id => indexById.get(id)!)
    : orderedIds.map((_, index) => index);
  const seedMass = 1 / seedIndexes.length;
  const seedVector = new Float64Array(n);
  for (const index of seedIndexes) seedVector[index] = seedMass;

  // Power iteration. Dangling mass (walkers on nodes with no out-arcs) restarts
  // at the seeds — absorption-free, so total mass stays 1 every iteration.
  let rank = Float64Array.from(seedVector);
  let iterations = 0;
  let converged = false;
  for (; iterations < maxIterations; ) {
    iterations++;
    const next = new Float64Array(n);
    let danglingMass = 0;
    for (let i = 0; i < n; i++) {
      const mass = rank[i];
      if (mass === 0) continue;
      const targets = outTargets[i];
      if (targets.length === 0) {
        danglingMass += mass;
        continue;
      }
      const share = mass / targets.length;
      for (const target of targets) next[target] += share;
    }
    let l1 = 0;
    for (let i = 0; i < n; i++) {
      const value = (1 - damping) * seedVector[i]
        + damping * (next[i] + danglingMass * seedVector[i]);
      l1 += Math.abs(value - rank[i]);
      next[i] = value;
    }
    rank = next;
    if (l1 < epsilon) {
      converged = true;
      break;
    }
  }

  // Normalize to [0,1] (max = 1) and round for byte-stable serialization.
  let max = 0;
  for (let i = 0; i < n; i++) if (rank[i] > max) max = rank[i];
  const scores = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const normalized = max > 0 ? rank[i] / max : 0;
    scores.set(orderedIds[i], Number(normalized.toFixed(SCORE_DECIMALS)));
  }

  return {
    scores,
    meta: {
      algorithm: 'seeded-random-walk-power-iteration',
      damping,
      epsilon,
      max_iterations: maxIterations,
      iterations,
      converged,
      seed_count: seedIndexes.length,
      seed_source: seedSource,
      node_count: n,
      edge_count: edgeCount,
    },
  };
}
