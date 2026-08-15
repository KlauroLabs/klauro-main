




























import { CASEdge, CASEntryPoint, CASNode, CASStructuralImportanceMeta } from '../../types/cas.types';
import { isScaffoldOrTestPath } from './scaffold-paths';



const CALLISH_EDGE_TYPES = new Set([
  'calls', 'uses', 'depends_on', 'invokes', 'delegates_to', 'maps_to', 'queries', 'wraps',
]);

export interface StructuralImportanceOptions {

  damping?: number;

  epsilon?: number;

  maxIterations?: number;
}



export type StructuralImportanceMeta = CASStructuralImportanceMeta;

export interface StructuralImportanceResult {


  scores: Map<string, number>;
  meta: StructuralImportanceMeta;
}

const DEFAULT_DAMPING = 0.85;
const DEFAULT_EPSILON = 1e-8;



const DEFAULT_MAX_ITERATIONS = 150;
const SCORE_DECIMALS = 8;

type SeedableNode = Pick<CASNode, 'id' | 'source' | 'metadata'>;



function isSeedableEntryPoint(entryPoint: CASEntryPoint): boolean {
  return entryPoint.type !== 'test';
}


function isTestShapedNode(node: SeedableNode | undefined): boolean {
  if (!node) return true;
  if (node.metadata?.is_test === true) return true;
  const file = node.source?.file;
  if (file && isScaffoldOrTestPath(file)) return true;
  return false;
}






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





export function computeStructuralImportance(
  nodes: SeedableNode[],
  edges: CASEdge[],
  entryPoints: CASEntryPoint[],
  options: StructuralImportanceOptions = {}
): StructuralImportanceResult {
  const damping = options.damping ?? DEFAULT_DAMPING;
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;


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

  for (const targets of outTargets) targets.sort((a, b) => a - b);




  const seedIds = resolveSeedNodeIds(entryPoints, nodesById);
  const seedSource: 'entry-points' | 'uniform' = seedIds.length > 0 ? 'entry-points' : 'uniform';
  const seedIndexes = seedSource === 'entry-points'
    ? seedIds.map(id => indexById.get(id)!)
    : orderedIds.map((_, index) => index);
  const seedMass = 1 / seedIndexes.length;
  const seedVector = new Float64Array(n);
  for (const index of seedIndexes) seedVector[index] = seedMass;



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
