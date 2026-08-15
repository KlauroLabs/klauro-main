






































import { ReachabilityIndex } from '../../../../packages/analyzer-core/src/analyzer/core/reachability-index';







export const DEFAULT_BLAST_RADIUS_DEPTH = 4;
export const DEFAULT_BLAST_RADIUS_MAX_NODES = 200;

export interface PartitionTask {
  id: string;
  intent: string;

  target_symbols?: string[];

  target_paths?: string[];













  flow_id?: string;
  capability_id?: string;
}


export interface WorkBatch {
  batch_index: number;
  task_ids: string[];
}

export interface ConflictEdge {
  a: string;
  b: string;
  reason: 'symbol' | 'path' | 'blast-radius';
}

export interface PartitionResult {
  batches: WorkBatch[];

  parallelism_factor: number;
  conflict_edges: ConflictEdge[];




  unpartitionable?: string[];






  footprint_source?: Record<string, 'declared' | 'inferred'>;











  concept_groups?: ConceptGroup[];











  predicted_conflicts?: PredictedConflictEdge[];
}


export interface PredictedConflictEdge {
  a: string;
  b: string;

  file_a: string;
  file_b: string;

  probability: number;




  separated: boolean;
}


export interface ConceptGroup {


  kind: 'flow' | 'capability';
  concept_id: string;
  task_ids: string[];
}

export interface PartitionOptions {





  includeBlastRadius?: boolean;














  blastRadiusDepth?: number;







  blastRadiusMaxNodes?: number;












  coChangeIndex?: CoChangeIndexLike;





  coChangeThreshold?: number;
}





export interface CoChangeIndexLike {
  [file: string]: Array<{ file: string; probability: number; support?: number; lift?: number }>;
}







function coChangeProbability(index: CoChangeIndexLike, fileA: string, fileB: string): number {
  const forward = index[fileA]?.find((p) => p.file === fileB)?.probability;
  const backward = index[fileB]?.find((p) => p.file === fileA)?.probability;
  if (forward === undefined && backward === undefined) return 0;
  return Math.max(forward ?? 0, backward ?? 0);
}







export interface PartitionCasNode {
  id: string;
  name: string;
}

export interface PartitionCasEdge {
  source: string;
  target: string;
  type: string;
}

export interface PartitionCas {
  nodes: PartitionCasNode[];
  edges: PartitionCasEdge[];





  files?: string[];
}














function resolveIds(cas: PartitionCas, nameOrId: string): string[] {
  const matches = cas.nodes.filter((n) => n.id === nameOrId || n.name === nameOrId);
  if (matches.length === 0) return [nameOrId];
  return matches.map((n) => n.id);
}









function buildBlastRadiusExpander(
  cas: PartitionCas,
  maxDepth: number,
  maxNodes: number
): (symbolIds: Set<string>) => Set<string> {
  const index = ReachabilityIndex.build(
    cas.nodes.map((n) => n.id),
    cas.edges.filter((e) => e.type === 'calls').map((e) => [e.source, e.target] as const)
  );
  return (symbolIds: Set<string>) => {
    if (symbolIds.size === 0) return new Set(symbolIds);
    const { affected } = index.affectedSet(symbolIds, {
      direction: 'both',
      maxDepth,
      maxNodes,
      includeSeeds: true,
    });


    const expanded = new Set(symbolIds);
    for (const id of affected) expanded.add(id);
    return expanded;
  };
}








export interface InferredFootprint {
  symbols: string[];
  paths: string[];
}


























export function inferFootprintFromIntent(intent: string, cas: PartitionCas): InferredFootprint {
  const symbolIds = new Set<string>();
  const paths = new Set<string>();

  const nodesByName = new Map<string, PartitionCasNode>();
  const nodesById = new Map<string, PartitionCasNode>();
  for (const n of cas.nodes) {
    nodesByName.set(n.name, n);
    nodesById.set(n.id, n);
  }
  const fileSet = new Set(cas.files ?? []);

  const tryMatchSymbol = (token: string) => {
    const cleaned = token.trim();
    if (!cleaned) return;
    const byName = nodesByName.get(cleaned);
    if (byName) symbolIds.add(byName.id);
    const byId = nodesById.get(cleaned);
    if (byId) symbolIds.add(byId.id);
  };

  const tryMatchPath = (token: string) => {
    const cleaned = normalizePath(token.trim());
    if (cleaned && fileSet.has(cleaned)) paths.add(cleaned);
  };


  const backtickSpans = intent.match(/`([^`]+)`/g) ?? [];
  for (const span of backtickSpans) {
    const inner = span.slice(1, -1);
    tryMatchSymbol(inner);
    tryMatchPath(inner);
  }



  const words = intent.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  for (const w of words) {
    tryMatchSymbol(w);
  }


  const pathLike = intent.match(/[./\w-]+\/[./\w-]+|[.\w-]+\.[A-Za-z]{1,5}\b/g) ?? [];
  for (const p of pathLike) {
    tryMatchPath(p);
  }

  return { symbols: [...symbolIds], paths: [...paths] };
}





interface TaskFootprint {
  task_id: string;
  symbols: Set<string>;
  paths: Set<string>;
}

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '');
}




function declaredSymbolAndPathIds(
  task: PartitionTask,
  cas: PartitionCas
): { symbolIds: Set<string>; paths: Set<string> } {
  const symbolIds = new Set<string>();
  for (const s of task.target_symbols ?? []) {
    for (const id of resolveIds(cas, s)) symbolIds.add(id);
  }
  const paths = new Set((task.target_paths ?? []).map(normalizePath));
  return { symbolIds, paths };
}

function computeFootprint(
  task: PartitionTask,
  cas: PartitionCas,
  expandBlastRadius: ((symbolIds: Set<string>) => Set<string>) | null,
  fallbackToInference: boolean
): TaskFootprint {
  let { symbolIds: declaredSymbolIds, paths } = declaredSymbolAndPathIds(task, cas);

  if (fallbackToInference && declaredSymbolIds.size === 0 && paths.size === 0) {
    const inferred = inferFootprintFromIntent(task.intent, cas);
    for (const id of inferred.symbols) declaredSymbolIds.add(id);
    for (const p of inferred.paths) paths.add(normalizePath(p));
  }

  const symbols = expandBlastRadius ? expandBlastRadius(declaredSymbolIds) : declaredSymbolIds;

  return { task_id: task.id, symbols, paths };
}

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}



function hasNoDeclaredFootprint(task: PartitionTask): boolean {
  return (task.target_symbols?.length ?? 0) === 0 && (task.target_paths?.length ?? 0) === 0;
}


function hasNoFootprintAtAll(task: PartitionTask, cas: PartitionCas): boolean {
  if (!hasNoDeclaredFootprint(task)) return false;
  const inferred = inferFootprintFromIntent(task.intent, cas);
  return inferred.symbols.length === 0 && inferred.paths.length === 0;
}





function footprintsConflict(a: TaskFootprint, b: TaskFootprint): ConflictEdge['reason'] | null {
  for (const s of a.symbols) {
    if (b.symbols.has(s)) return 'symbol';
  }
  for (const p of a.paths) {
    for (const q of b.paths) {
      if (pathsOverlap(p, q)) return 'path';
    }
  }
  return null;
}








function classifyReason(
  declaredA: TaskFootprint,
  declaredB: TaskFootprint,
  reason: ConflictEdge['reason']
): ConflictEdge['reason'] {
  if (reason !== 'symbol') return reason;
  const declaredOverlap = [...declaredA.symbols].some((s) => declaredB.symbols.has(s));
  return declaredOverlap ? 'symbol' : 'blast-radius';
}


























function colorIntoBatches(
  taskIds: string[],
  conflicts: Map<string, Set<string>>,
  softConflictWeights?: Map<string, Map<string, number>>,
  maxBatches?: number
): string[][] {
  const batches: string[][] = [];

  for (const id of taskIds) {
    const conflictsWith = conflicts.get(id) ?? new Set<string>();
    const softWith = softConflictWeights?.get(id);

    let bestIndex = -1;
    let bestWeight = Infinity;
    for (let i = 0; i < batches.length; i++) {
      const clashes = batches[i].some((other) => conflictsWith.has(other));
      if (clashes) continue;
      const weight = softWith
        ? batches[i].reduce((sum, other) => sum + (softWith.get(other) ?? 0), 0)
        : 0;
      if (weight < bestWeight) {
        bestWeight = weight;
        bestIndex = i;
        if (weight === 0) break;
      }
    }

    if (bestIndex === -1) {



      batches.push([id]);
      continue;
    }

    const canOpenFreshForSoftReason = maxBatches === undefined || batches.length < maxBatches;
    if (bestWeight > 0 && canOpenFreshForSoftReason) {




      batches.push([id]);
    } else {
      batches[bestIndex].push(id);
    }
  }
  return batches;
}









export function partitionTasks(
  tasks: PartitionTask[],
  cas: PartitionCas,
  options: PartitionOptions = {}
): PartitionResult {
  const includeBlastRadius = options.includeBlastRadius ?? true;
  const blastRadiusDepth = options.blastRadiusDepth ?? DEFAULT_BLAST_RADIUS_DEPTH;
  const blastRadiusMaxNodes = options.blastRadiusMaxNodes ?? DEFAULT_BLAST_RADIUS_MAX_NODES;


  const expandBlastRadius = includeBlastRadius
    ? buildBlastRadiusExpander(cas, blastRadiusDepth, blastRadiusMaxNodes)
    : null;


  const unpartitionable = tasks.filter((t) => hasNoDeclaredFootprint(t) && hasNoFootprintAtAll(t, cas)).map((t) => t.id);

  const footprint_source: Record<string, 'declared' | 'inferred'> = {};
  for (const t of tasks) {
    if (!hasNoDeclaredFootprint(t)) {
      footprint_source[t.id] = 'declared';
    } else if (!hasNoFootprintAtAll(t, cas)) {
      footprint_source[t.id] = 'inferred';
    }

  }





  const declaredFootprints = new Map(tasks.map((t) => [t.id, computeFootprint(t, cas, null, true)]));
  const expandedFootprints = new Map(
    tasks.map((t) => [t.id, expandBlastRadius ? computeFootprint(t, cas, expandBlastRadius, true) : declaredFootprints.get(t.id)!])
  );

  const conflictEdges: ConflictEdge[] = [];
  const conflicts = new Map<string, Set<string>>();
  for (const t of tasks) conflicts.set(t.id, new Set());

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const taskA = tasks[i];
      const taskB = tasks[j];
      const fpA = expandedFootprints.get(taskA.id)!;
      const fpB = expandedFootprints.get(taskB.id)!;
      const rawReason = footprintsConflict(fpA, fpB);
      if (!rawReason) continue;

      const reason = classifyReason(declaredFootprints.get(taskA.id)!, declaredFootprints.get(taskB.id)!, rawReason);
      conflictEdges.push({ a: taskA.id, b: taskB.id, reason });
      conflicts.get(taskA.id)!.add(taskB.id);
      conflicts.get(taskB.id)!.add(taskA.id);
    }
  }





  const coChangeIndex = options.coChangeIndex;
  const coChangeThreshold = options.coChangeThreshold ?? 0.5;
  const predictedConflicts: PredictedConflictEdge[] = [];
  const softWeights = new Map<string, Map<string, number>>();
  for (const t of tasks) softWeights.set(t.id, new Map());

  if (coChangeIndex) {
    for (let i = 0; i < tasks.length; i++) {
      for (let j = i + 1; j < tasks.length; j++) {
        const taskA = tasks[i];
        const taskB = tasks[j];
        if (conflicts.get(taskA.id)!.has(taskB.id)) continue;

        const pathsA = [...declaredFootprints.get(taskA.id)!.paths];
        const pathsB = [...declaredFootprints.get(taskB.id)!.paths];
        if (pathsA.length === 0 || pathsB.length === 0) continue;

        let best: { fileA: string; fileB: string; probability: number } | null = null;
        for (const fa of pathsA) {
          for (const fb of pathsB) {
            const p = coChangeProbability(coChangeIndex, fa, fb);
            if (p >= coChangeThreshold && (!best || p > best.probability)) {
              best = { fileA: fa, fileB: fb, probability: p };
            }
          }
        }
        if (!best) continue;

        softWeights.get(taskA.id)!.set(taskB.id, best.probability);
        softWeights.get(taskB.id)!.set(taskA.id, best.probability);
        predictedConflicts.push({
          a: taskA.id,
          b: taskB.id,
          file_a: best.fileA,
          file_b: best.fileB,
          probability: best.probability,
          separated: false,
        });
      }
    }
  }

  const taskIds = tasks.map((t) => t.id);








  let maxBatchesAllowed: number | undefined;
  if (coChangeIndex && predictedConflicts.length > 0) {
    const hardOnlyCount = colorIntoBatches(taskIds, conflicts).length;
    maxBatchesAllowed = hardOnlyCount >= tasks.length ? hardOnlyCount : Math.max(hardOnlyCount, tasks.length - 1);
  }

  const colored = colorIntoBatches(taskIds, conflicts, coChangeIndex ? softWeights : undefined, maxBatchesAllowed);
  const batches: WorkBatch[] = colored.map((task_ids, batch_index) => ({ batch_index, task_ids }));

  const batchOfTask = new Map<string, number>();
  colored.forEach((ids, idx) => ids.forEach((id) => batchOfTask.set(id, idx)));
  for (const edge of predictedConflicts) {
    edge.separated = batchOfTask.get(edge.a) !== batchOfTask.get(edge.b);
  }

  const parallelism_factor = batches.length === 0 ? 0 : tasks.length / batches.length;
  const conceptGroups = groupTasksByConcept(tasks);

  return {
    batches,
    parallelism_factor,
    conflict_edges: conflictEdges,
    ...(unpartitionable.length > 0 ? { unpartitionable } : {}),
    footprint_source,
    ...(conceptGroups.length > 0 ? { concept_groups: conceptGroups } : {}),
    ...(coChangeIndex ? { predicted_conflicts: predictedConflicts } : {}),
  };
}











export function groupTasksByConcept(tasks: PartitionTask[]): ConceptGroup[] {
  const byFlow = new Map<string, string[]>();
  const byCapability = new Map<string, string[]>();

  for (const t of tasks) {
    if (t.flow_id) {
      const list = byFlow.get(t.flow_id) ?? [];
      list.push(t.id);
      byFlow.set(t.flow_id, list);
    } else if (t.capability_id) {
      const list = byCapability.get(t.capability_id) ?? [];
      list.push(t.id);
      byCapability.set(t.capability_id, list);
    }
  }

  const groups: ConceptGroup[] = [];
  for (const [concept_id, task_ids] of byFlow) groups.push({ kind: 'flow', concept_id, task_ids });
  for (const [concept_id, task_ids] of byCapability) groups.push({ kind: 'capability', concept_id, task_ids });
  return groups;
}
