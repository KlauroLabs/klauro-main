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
 * blast-radius expansion of those footprints. When a task declares nothing,
 * it falls back to a DETERMINISTIC heuristic — `inferFootprintFromIntent` —
 * that tokenizes the free-text `intent` and matches candidate identifiers
 * against real CAS node names / file paths (see that function's doc for the
 * exact heuristic and its precision limits). This is pattern matching
 * against ground truth, NOT NLP/semantic understanding and NOT AI — a task
 * whose intent mentions no real CAS entity still lands in `unpartitionable`
 * (kept visible, never silently dropped) rather than guessed at. AI-based
 * (semantic) inference is a separate, deeper follow-on — see the note at the
 * bottom of this file.
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
  /**
   * Optional conceptual coordinates (§4 SPEC-CONCEPTUAL-LAYER.md, "the
   * fabric's conceptual vocabulary"): the flow/capability this task's work
   * belongs to. Purely additive — this module stays transport/IO-free and
   * does not import `conceptual-scope.ts`'s `ConceptIndex`/derivation logic
   * (that needs a real CAS + flow-concepts pass); callers who already have
   * that mapping (server.ts, via `deriveConceptualCoordinate`) pass the
   * resolved ids straight in here. When present, `partitionByConcept`
   * (below) uses these ids to additionally batch by CONCEPTUAL blast radius
   * (different flows/capabilities => different batches allowed to run in
   * parallel even when partitionTasks' file/symbol coloring alone wouldn't
   * have separated them this cleanly) — see that function's doc.
   */
  flow_id?: string;
  capability_id?: string;
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
  /** Tasks with no derivable footprint at all — neither declared
   *  (target_symbols/target_paths) nor inferred from intent text against the
   *  CAS. Kept visible, never dropped from the task set — see the module
   *  header. */
  unpartitionable?: string[];
  /** Per-task provenance of the footprint actually used for partitioning:
   *  'declared' when the task stated target_symbols/target_paths itself,
   *  'inferred' when those were empty and `inferFootprintFromIntent` found a
   *  match in the CAS instead. Absent entries had no footprint at all (see
   *  `unpartitionable`). Kept separate and honest so callers never mistake a
   *  heuristic guess for an authoritative declaration. */
  footprint_source?: Record<string, 'declared' | 'inferred'>;
  /**
   * Conceptual blast-radius grouping (§4 SPEC-CONCEPTUAL-LAYER.md): tasks
   * grouped by `flow_id` (falling back to `capability_id` when no flow_id is
   * set), for tasks that declared either. Purely informational/additive on
   * top of `batches` — it does NOT change the file/symbol coloring above,
   * it answers a DIFFERENT question ("which tasks are conceptually disjoint
   * — different flows/capabilities entirely — and so safe to route to
   * separate agents/waves even before file-level analysis"). Only present
   * when at least one task declared a `flow_id`/`capability_id`; tasks with
   * neither are omitted here (they simply aren't groupable conceptually,
   * same honesty stance as `unpartitionable` above). */
  concept_groups?: ConceptGroup[];
}

/** One flow/capability's worth of conceptually co-located tasks. */
export interface ConceptGroup {
  /** 'flow' when grouped by flow_id, 'capability' when only capability_id was
   *  available (no flow_id declared). */
  kind: 'flow' | 'capability';
  concept_id: string;
  task_ids: string[];
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
  /** Optional known file list for the repo (relative paths). Used by
   *  `inferFootprintFromIntent` to match file-path-looking tokens in
   *  free-text intent against real files. Additive/optional so existing CAS
   *  fixtures without a file list keep working — inference then falls back
   *  to symbol-name matching only. */
  files?: string[];
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
// Intent-inference (deterministic heuristic — NOT AI/NLP)
// ---------------------------------------------------------------------------

/** Result of a best-effort attempt to derive a footprint from free-text
 *  intent when a task declares none. Always empty (never guessed) when the
 *  intent text mentions no entity that actually exists in the CAS. */
export interface InferredFootprint {
  symbols: string[];
  paths: string[];
}

/**
 * Deterministically extract candidate identifiers from a task's free-text
 * `intent` and keep only the ones that match a REAL entity in the CAS (node
 * id/name, or a known file path). This is string/pattern matching against
 * ground truth — no NLP, no embeddings, no AI. Precision over recall: a
 * plausible-looking token that doesn't resolve to anything real is dropped,
 * not guessed at. See the module header for why AI-based semantic inference
 * is intentionally a separate, deeper follow-on.
 *
 * Candidate extraction, in order:
 *  1. Backtick / `code`-span tokens (`` `getUser` ``) — explicit code
 *     mentions the author bothered to mark up; highest-confidence source.
 *  2. CamelCase / PascalCase / snake_case identifier-looking tokens anywhere
 *     in the text (e.g. "getUser", "render_profile") — the common case for
 *     unmarked intent like "refactor getUser to be non-null".
 *  3. File-path-looking tokens (contain a `/` or end in a known extension,
 *     e.g. "src/app.ts") — matched against `cas.files` when present.
 * Every candidate is matched case-sensitively against `cas.nodes[].name`,
 * `cas.nodes[].id`, and `cas.files` — never fuzzy, never partial — so the
 * false-positive rate is bounded by "this exact name happens to also appear
 * in the CAS for an unrelated reason," which is rare for real identifiers.
 * False negatives (a real target described only in plain English, e.g. "fix
 * the login bug") are expected and intentional: those tasks correctly stay
 * `unpartitionable` rather than being matched to the wrong thing.
 */
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

  // 1. Backtick / `code`-span tokens: `foo`, `` `a/b.ts` ``.
  const backtickSpans = intent.match(/`([^`]+)`/g) ?? [];
  for (const span of backtickSpans) {
    const inner = span.slice(1, -1);
    tryMatchSymbol(inner);
    tryMatchPath(inner);
  }

  // 2. Bare identifier-looking tokens (word chars only, split on
  //    non-identifier characters — punctuation, whitespace, quotes).
  const words = intent.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  for (const w of words) {
    tryMatchSymbol(w);
  }

  // 3. File-path-looking tokens: contain a `/` or a dotted extension.
  const pathLike = intent.match(/[./\w-]+\/[./\w-]+|[.\w-]+\.[A-Za-z]{1,5}\b/g) ?? [];
  for (const p of pathLike) {
    tryMatchPath(p);
  }

  return { symbols: [...symbolIds], paths: [...paths] };
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

/** Declared (literal, task-stated) footprint only — no inference, no
 *  blast-radius. Building block for both `computeFootprint` and the
 *  unpartitionable/inferred-fallback decision in `partitionTasks`. */
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
  includeBlastRadius: boolean,
  fallbackToInference: boolean
): TaskFootprint {
  let { symbolIds: declaredSymbolIds, paths } = declaredSymbolAndPathIds(task, cas);

  if (fallbackToInference && declaredSymbolIds.size === 0 && paths.size === 0) {
    const inferred = inferFootprintFromIntent(task.intent, cas);
    for (const id of inferred.symbols) declaredSymbolIds.add(id);
    for (const p of inferred.paths) paths.add(normalizePath(p));
  }

  const symbols = includeBlastRadius ? oneHopCallGraph(cas, declaredSymbolIds) : declaredSymbolIds;

  return { task_id: task.id, symbols, paths };
}

function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

/** True footprint (pre-blast-radius, pre-inference) is empty — nothing
 *  declared at all by the task itself. */
function hasNoDeclaredFootprint(task: PartitionTask): boolean {
  return (task.target_symbols?.length ?? 0) === 0 && (task.target_paths?.length ?? 0) === 0;
}

/** Neither declared NOR inferred — truly nothing to partition on. */
function hasNoFootprintAtAll(task: PartitionTask, cas: PartitionCas): boolean {
  if (!hasNoDeclaredFootprint(task)) return false;
  const inferred = inferFootprintFromIntent(task.intent, cas);
  return inferred.symbols.length === 0 && inferred.paths.length === 0;
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

  // Truly nothing to go on — neither declared nor inferable from intent.
  const unpartitionable = tasks.filter((t) => hasNoDeclaredFootprint(t) && hasNoFootprintAtAll(t, cas)).map((t) => t.id);

  const footprint_source: Record<string, 'declared' | 'inferred'> = {};
  for (const t of tasks) {
    if (!hasNoDeclaredFootprint(t)) {
      footprint_source[t.id] = 'declared';
    } else if (!hasNoFootprintAtAll(t, cas)) {
      footprint_source[t.id] = 'inferred';
    }
    // else: no entry — task is unpartitionable, see above.
  }

  // Every task still participates in coloring — even one with no derivable
  // footprint conflicts with nothing, so it always lands in batch 0 (or
  // wherever it's first tried), which is the correct behavior: we don't drop
  // it, and we don't falsely serialize it against unrelated work either.
  const declaredFootprints = new Map(tasks.map((t) => [t.id, computeFootprint(t, cas, false, true)]));
  const expandedFootprints = new Map(
    tasks.map((t) => [t.id, includeBlastRadius ? computeFootprint(t, cas, true, true) : declaredFootprints.get(t.id)!])
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
  const conceptGroups = groupTasksByConcept(tasks);

  return {
    batches,
    parallelism_factor,
    conflict_edges: conflictEdges,
    ...(unpartitionable.length > 0 ? { unpartitionable } : {}),
    footprint_source,
    ...(conceptGroups.length > 0 ? { concept_groups: conceptGroups } : {}),
  };
}

/**
 * Group tasks by conceptual blast radius: same `flow_id` (preferred, finer
 * granularity) or same `capability_id` (fallback, when no flow_id is set) go
 * in the same group. Tasks with neither are omitted — never guessed. This is
 * the "partition by capability/flow so parallel batches are conceptually
 * disjoint" primitive from §4: two batches with DIFFERENT concept_ids are
 * working on entirely different flows/capabilities and can be routed to
 * separate agents/waves with maximal confidence, independent of whatever
 * file/symbol coloring `batches` above computed.
 */
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

// ---------------------------------------------------------------------------
// Follow-on (explicitly NOT built here, per the mission's honesty mandate):
//
// `inferFootprintFromIntent` above is DETERMINISTIC string/pattern matching
// against real CAS entity names and files — it closes the common case
// ("refactor getUser to be non-null" -> matches the real getUser node) but
// it is bounded by what the intent text literally names. It cannot resolve
// intent that only describes behavior in plain English with no identifier
// mentioned at all (e.g. "fix the bug where users get logged out early") —
// those tasks correctly stay `unpartitionable`.
//
// A deeper follow-on is AI/semantic inference: an LLM pass that reads the
// intent, understands what it means, and proposes candidate CAS entities
// even when no literal name is present — mirroring conceptual-conflict.ts's
// optional, pluggable `InvariantInterpreter` pattern (deterministic core
// untouched, AI-flavored inference layered on top and OFF by default). That
// carries real precision risk (an LLM can propose a plausible-but-wrong
// target) and needs its own confidence/verification story before it can
// safely widen a batch's parallelism — intentionally out of scope here.
// ---------------------------------------------------------------------------
