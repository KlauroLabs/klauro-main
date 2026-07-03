/**
 * Work-partitioner (§1.5 "Proactive partitioning" + P6 of
 * docs/SPEC-COORDINATION-FABRIC-V2.md) — the accelerant.
 *
 * Everything upstream in this module (arbiter/collision/grant-manager,
 * conceptual-conflict) reacts to overlap AFTER two agents are already
 * mid-flight: detect a collision, arbitrate a claim, flag a conceptual
 * conflict. This module runs BEFORE any agent starts: given a batch of
 * pending tasks and the CAS graph, it computes the MAXIMALLY-PARALLEL
 * non-conflicting partition up front, so the fleet is routed to avoid most
 * collisions rather than merely surviving them. This is the "manual
 * orchestrator loop" (decompose -> disjoint claims -> fan out -> reconcile)
 * that ran the real 6-agent battle-test by hand, automated.
 *
 * North-star metric (per §1.5): throughput / parallelism_factor / block-time
 * -> 0 — NOT "collisions prevented". A batch of N mutually-non-conflicting
 * tasks is meant to run FULLY PARALLEL (block-time = 0 by construction); the
 * only thing serialized is genuinely-conflicting work, and even that is
 * pushed to the minimum number of sequential batches (graph coloring, not an
 * arbitrary queue).
 *
 * Scope / honesty note: this module partitions DECLARED footprints
 * (`target_symbols` / `target_paths` the task itself states) plus CAS
 * blast-radius expansion of those footprints. It does NOT attempt to infer a
 * task's footprint from free-text `intent` — that is NLP-hard, unreliable,
 * and out of scope; see the follow-on note at the bottom of this file. A
 * task with no declared footprint is reported in `unpartitionable` (kept
 * visible, never silently dropped) rather than guessed at or discarded.
 *
 * Pure module: no IO, no transport, no storage reads — same discipline as
 * collision.ts / conceptual-conflict.ts. The CAS is passed in by the caller
 * (a real CASOutput from query.ts, or any object shaped like ConflictCas).
 */

// ---------------------------------------------------------------------------
// Input model
// ---------------------------------------------------------------------------

export interface PartitionTask {
  id: string;
  intent: string;
  /** Symbols the task will edit — node ids (preferred) or bare names. */
  target_symbols?: string[];
  /** Files the task will touch. */
  target_paths?: string[];
}

/** One batch of mutually non-conflicting tasks — all run fully parallel. */
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
  /** tasks / batches — higher means more parallel. 1 = fully serial, N = fully parallel. */
  parallelism_factor: number;
  conflict_edges: ConflictEdge[];
  /** Tasks with no derivable footprint (no target_symbols/target_paths). Kept
   *  visible, never dropped from the task set — see the module header. */
  unpartitionable?: string[];
}

export interface PartitionOptions {
  /** Expand each task's footprint by one hop of CAS call-graph edges
   *  (callers + callees) before computing conflicts. Default true — this is
   *  the moat: competitors partitioning by file/path alone cannot see that
   *  two textually-disjoint edits both reach into the same contract surface. */
  includeBlastRadius?: boolean;
}

/**
 * Minimal CAS shape this module needs: nodes with id/name and edges with
 * source/target/type. Deliberately loose (`any`-ish via structural typing)
 * so a real CASOutput (query.ts) or a hand-built fixture both work without
 * adapting — matches the pattern in conceptual-conflict.ts's `ConflictCas`.
 */
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
}

// ---------------------------------------------------------------------------
// Blast-radius helpers (local — mirrors getCallers/getCallees from query.ts,
// scoped to one hop over "calls" edges, the only edge kind both this module
// and conceptual-conflict.ts need for a scheduling-grade footprint).
// ---------------------------------------------------------------------------

/** Resolve a symbol name-or-id to every matching node id in the CAS. Passes
 *  through unresolved inputs unchanged so hand-built fixtures / synthetic
 *  symbol ids (no matching CAS node) still participate in conflict checks. */
function resolveIds(cas: PartitionCas, nameOrId: string): string[] {
  const matches = cas.nodes.filter((n) => n.id === nameOrId || n.name === nameOrId);
  if (matches.length === 0) return [nameOrId];
  return matches.map((n) => n.id);
}

/** One hop of callers + callees (via "calls" edges) for a set of symbol ids. */
function oneHopCallGraph(cas: PartitionCas, symbolIds: Set<string>): Set<string> {
  const expanded = new Set(symbolIds);
  for (const edge of cas.edges) {
    if (edge.type !== 'calls') continue;
    if (symbolIds.has(edge.source)) expanded.add(edge.target);
    if (symbolIds.has(edge.target)) expanded.add(edge.source);
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// Footprint computation
// ---------------------------------------------------------------------------

interface TaskFootprint {
  task_id: string;
  symbols: Set<string>;
  paths: Set<string>;
}

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '');
}

function computeFootprint(task: PartitionTask, cas: PartitionCas, includeBlastRadius: boolean): TaskFootprint {
  const declaredSymbolIds = new Set<string>();
  for (const s of task.target_symbols ?? []) {
    for (const id of resolveIds(cas, s)) declaredSymbolIds.add(id);
  }

  const symbols = includeBlastRadius ? oneHopCallGraph(cas, declaredSymbolIds) : declaredSymbolIds;
  const paths = new Set((task.target_paths ?? []).map(normalizePath));

  return { task_id: task.id, symbols, paths };
}

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

/** True footprint (pre-blast-radius) is empty — nothing declared at all. */
function hasNoDeclaredFootprint(task: PartitionTask): boolean {
  return (task.target_symbols?.length ?? 0) === 0 && (task.target_paths?.length ?? 0) === 0;
}

// ---------------------------------------------------------------------------
// Conflict graph
// ---------------------------------------------------------------------------

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

/**
 * Refine a raw 'symbol' conflict reason to 'blast-radius' when the two
 * tasks' DECLARED (non-expanded) footprints don't themselves intersect — the
 * only reason they conflict is that blast-radius expansion brought them
 * together. This is the distinction the throughput bench proves out: a
 * file-only partitioner would miss it entirely.
 */
function classifyReason(
  declaredA: TaskFootprint,
  declaredB: TaskFootprint,
  reason: ConflictEdge['reason']
): ConflictEdge['reason'] {
  if (reason !== 'symbol') return reason;
  const declaredOverlap = [...declaredA.symbols].some((s) => declaredB.symbols.has(s));
  return declaredOverlap ? 'symbol' : 'blast-radius';
}

// ---------------------------------------------------------------------------
// Graph coloring (greedy, deterministic) -> parallel batches
// ---------------------------------------------------------------------------

/**
 * Greedy graph coloring: process tasks in a fixed (input) order, assign each
 * task the LOWEST-indexed batch that contains none of its conflicts. This is
 * a classic greedy coloring heuristic — not guaranteed minimum chromatic
 * number in the worst case, but deterministic, fast (O(tasks * batches *
 * avg_conflicts)), and exactly the algorithm a human orchestrator applies by
 * hand: "can this go in wave 1? no, conflicts with X. wave 2, then."
 */
function colorIntoBatches(taskIds: string[], conflicts: Map<string, Set<string>>): string[][] {
  const batches: string[][] = [];
  const batchOf = new Map<string, number>();

  for (const id of taskIds) {
    const conflictsWith = conflicts.get(id) ?? new Set<string>();
    let placed = false;
    for (let i = 0; i < batches.length; i++) {
      const clashes = batches[i].some((other) => conflictsWith.has(other));
      if (!clashes) {
        batches[i].push(id);
        batchOf.set(id, i);
        placed = true;
        break;
      }
    }
    if (!placed) {
      batches.push([id]);
      batchOf.set(id, batches.length - 1);
    }
  }
  return batches;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute the maximally-parallel non-conflicting partition of `tasks` over
 * `cas`. See the module header for the algorithm and scope notes.
 */
export function partitionTasks(
  tasks: PartitionTask[],
  cas: PartitionCas,
  options: PartitionOptions = {}
): PartitionResult {
  const includeBlastRadius = options.includeBlastRadius ?? true;

  const unpartitionable = tasks.filter(hasNoDeclaredFootprint).map((t) => t.id);

  // Every task still participates in coloring — even one with no declared
  // footprint conflicts with nothing, so it always lands in batch 0 (or
  // wherever it's first tried), which is the correct behavior: we don't drop
  // it, and we don't falsely serialize it against unrelated work either.
  const declaredFootprints = new Map(tasks.map((t) => [t.id, computeFootprint(t, cas, false)]));
  const expandedFootprints = new Map(
    tasks.map((t) => [t.id, includeBlastRadius ? computeFootprint(t, cas, true) : declaredFootprints.get(t.id)!])
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

  const taskIds = tasks.map((t) => t.id);
  const colored = colorIntoBatches(taskIds, conflicts);
  const batches: WorkBatch[] = colored.map((task_ids, batch_index) => ({ batch_index, task_ids }));

  const parallelism_factor = batches.length === 0 ? 0 : tasks.length / batches.length;

  return {
    batches,
    parallelism_factor,
    conflict_edges: conflictEdges,
    ...(unpartitionable.length > 0 ? { unpartitionable } : {}),
  };
}

// ---------------------------------------------------------------------------
// Follow-on (explicitly NOT built here, per the mission's honesty mandate):
//
// Auto-inferring a task's footprint (target_symbols/target_paths) from its
// free-text `intent` alone. That requires either NLP/semantic matching of
// intent text against the CAS's node names/descriptions, or an AI
// interpretation pass (mirroring conceptual-conflict.ts's optional,
// pluggable `InvariantInterpreter` pattern: deterministic core untouched,
// AI-flavored inference layered on top and OFF by default). Declared
// footprints are the reachable, valuable core; intent-inference is a
// separate, harder follow-on and is intentionally out of scope for this
// module.
// ---------------------------------------------------------------------------
