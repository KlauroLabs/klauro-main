import type {
  CASOutput,
  CASNode,
  CASEdge,
  CASEntryPoint,
  CASExitPoint,
  CASEntityLineage,
  CASCallChain,
  SystemCapability,
} from '../../types/cas.types';
import { buildTerminalSignal } from './terminal-signal';

/**
 * FLOW CONCEPTS — the FLOW -> STEP tier of the conceptual understanding layer
 * (docs/SPEC-CONCEPTUAL-LAYER.md). Capabilities (already computed — CAS/WAS
 * product_map/system_capabilities) answer "what does it do". Flows answer
 * "how does a request/job move through it, step by step" — an ordered set of
 * semantic STEPS (Validate -> Charge -> Persist -> Notify), each carrying the
 * same I/L/S/O + Constraints contract used everywhere else in the product
 * (get_interface_signature's join), aggregated flow-level.
 *
 * DETERMINISTIC-FIRST: this module composes facts CAS already has —
 * entry_points (flow roots), call edges + method_calls (the chain),
 * exit_points + data_lineage (side-effect character, used both to segment
 * and to fill side_effects), data_entities.invariants + entry_point
 * validation/security guards (constraints), system_capabilities.operations
 * (capability linkage). AI is not used for facts; `opts.nameStep` is the only
 * seam, and it is fully inert when omitted.
 */

/**
 * THE UNIFORM UNDERSTANDING CONTRACT — "ICELOT". The model name lives in ONE
 * place so it is trivially renamable. Every unit (flow, step, function/node)
 * carries the same 6-facet contract, and every facet is EVIDENCE-GATED: a facet
 * is only populated from a fact the CAS already extracted, never fabricated.
 * Absent facets are omitted, not invented.
 *
 * ICELOT is NOT an execution order — it is the six questions asked of every unit:
 *   I. Input        — what does it take?    params / consumed request shape / reads.
 *   C. Constraints  — what bounds it?       validation / auth / rate-limit / error /
 *                     invariant / consistency rules, each with kind + evidence.
 *   E. Effects      — what does it touch?   system effects: integrations (outbound
 *                     calls) + state_changes (DB/cache/file writes, mutations).
 *   L. Logic        — how does it decide?   what it computes / the ordered behavior.
 *   O. Output       — what does it emit?    returns / produced responses & entities.
 *   T. Telemetry    — how does it behave?   joined runtime metrics (traffic / errors /
 *                     latency) when real observations exist for the unit.
 *
 * Reads as: contract surface (I, C) → impact surface (E) → internal behavior
 * (L, O) → observable runtime behavior (T).
 */
export const CONTRACT_MODEL_NAME = 'ICELOT';

export const UNDERSTANDING_CONTRACT_FACETS = [
  'input',
  'constraints',
  'system_effects',
  'logic',
  'output',
  'telemetry',
] as const;

export type UnderstandingContractFacet = (typeof UNDERSTANDING_CONTRACT_FACETS)[number];

/** What kind of constraint this is — governs how an agent should honor it.
 *  Each value maps 1:1 to a fact source the CAS already computes. */
export type ConstraintKind =
  | 'validation'   // input validation schema / required fields / types
  | 'auth'         // authentication / authorization guard on the entry point
  | 'rate-limit'   // throughput / quota guard, when surfaced
  | 'error'        // failure-mode / error contract (throws, uncaught paths)
  | 'invariant'    // data-entity or behavioral invariant enforced here
  | 'business-rule'// guard clause / gating conditional in the unit's own source
  | 'consistency'; // CAP / staleness posture: reads here may be eventual

/** A single first-class constraint on a unit, carrying its evidence + kind so
 *  an agent can both honor it and trace WHY it holds. Never fabricated — the
 *  `evidence` string is always the concrete fact that produced it. */
export interface FacetConstraint {
  kind: ConstraintKind;
  /** Human-legible rule ("caller must be authenticated", "amount > 0"). */
  rule: string;
  /** The concrete CAS fact that drove this constraint (guard text, guard
   *  name, invariant description, consistency posture evidence, …). */
  evidence: string;
}

/** Runtime "how this unit actually runs" — a compact projection of the
 *  per-node runtime metrics (buildNodeRuntimeMetrics) joined onto a unit when
 *  real observations exist for it. Omitted entirely when there is no runtime
 *  data — never fabricated, never zero-filled. */
export interface ContractTelemetry {
  /** CAS static id the metrics correlated to (node / entry-point / route). */
  static_id: string;
  request_count: number;
  error_rate: number;
  /** Latency percentiles in ms (only the ones present are set). */
  p50_ms?: number;
  p95_ms?: number;
  p99_ms?: number;
  status_code_distribution?: Record<string, number>;
  /** 'ingested' | 'simulated' | 'mixed' — provenance of the observations. */
  source: string;
  last_seen?: string;
}

export interface ILSOContract {
  input: string[];
  logic: string;
  side_effects: {
    state_changes: string[];
    external_integrations: string[];
  };
  output: string[];
  /** Business rules / invariants / guards / auth / validation / consistency
   *  enforced here — each a first-class {kind, rule, evidence} record derived
   *  from guard clauses, validation schemas, auth guards, data-entity/behavioral
   *  invariants, and the consistency model. Deterministic extraction only;
   *  never fabricated. Empty when none could be derived. */
  constraints: FacetConstraint[];
  /** Runtime metrics joined onto this unit when observations exist. Absent
   *  (undefined) when there is no runtime data — the pure/static analyzer never
   *  populates this; it is joined at the query layer from persisted telemetry. */
  telemetry?: ContractTelemetry;
}

export interface FlowStep {
  step_id: string;
  order: number;
  name: string;
  description: string;
  /**
   * Provenance of `name`/`description` — the ICELOT doctrine seam made
   * explicit. 'deterministic-label' = the structural template label
   * (nameStepDeterministically), a FACT-shaped label, never interpretation.
   * 'ai' = the interpretive naming/description pass (opts.nameStep, fed by
   * the query layer from the persisted AI element-description store) replaced
   * the label. The deterministic label always remains the fallback: when the
   * AI pass has not run (or was rejected), the step stays
   * 'deterministic-label' — provenance is never fabricated.
   */
  description_source: 'deterministic-label' | 'ai';
  contract: ILSOContract;
  /** 1:1, 1:many, or a SUB-SECTION of a single function (section present
   *  when the step is only part of one function's body). */
  functions: Array<{
    function_id: string;
    section?: { start_line: number; end_line: number; label?: string };
  }>;
  /** Data entities this step's own functions read or write (by name), from
   *  data_lineage/data_entities.lifecycle membership restricted to just this
   *  step's nodes — the same derivation as FlowConcept.entities, scoped
   *  down. Empty (not omitted) when this step genuinely touches no known
   *  entity. */
  entities: string[];
}

/**
 * Role of a flow ON A SPECIFIC capability↔flow relationship EDGE — RELATIONAL,
 * not intrinsic (docs/SEMANTIC-MODEL.md, Flow section): "Connect wallet" is
 * supporting for Trade-crypto and primary for Manage-wallets, simultaneously.
 * The role therefore lives on the edge, never on the flow itself.
 *
 * Deterministic (Camp-B) derivation rules — every role is grounded in a
 * structural ref, never a name keyword:
 *   - 'primary'       — a capability operation references this flow's entry
 *                        point (operations[].entry_point_id match).
 *   - 'supporting'    — the flow's TOUCHED ENTITIES overlap the capability's
 *                        related_entities, but its entry point is NOT among
 *                        the capability's operations.
 *   - 'operational'   — an entity-overlap edge whose flow the semantic-role
 *                        classifier classified 'infrastructure' (deploy /
 *                        install script entry — applied at the query layer via
 *                        applyFlowRoleToCapabilityRelationships).
 *   - 'observability' — an entity-overlap edge whose flow's exits are
 *                        dominated by telemetry exit kinds (exit-point type
 *                        facts, e.g. 'analytics').
 *   - 'prerequisite' / 'recovery' — in the vocabulary (doctrine roles) but
 *                        carry NO deterministic derivation rule yet; only an
 *                        AI/manual pass may assert them, evidence-gated.
 */
export type CapabilityFlowRole =
  | 'primary'
  | 'supporting'
  | 'prerequisite'
  | 'operational'
  | 'recovery'
  | 'observability';

/** One capability↔flow relationship edge. `rationale` always cites the
 *  concrete structural evidence that produced the edge (the operation ref,
 *  the shared entity names, the telemetry exit facts) — never fabricated. */
export interface CapabilityFlowRelationship {
  capability_id: string;
  role: CapabilityFlowRole;
  rationale: string;
}

/**
 * A single edge of a flow's STEP GRAPH (docs/SEMANTIC-MODEL.md, Flow section:
 * "Flow = semantic step GRAPH … the ordered step list shown to humans is a
 * PROJECTION of that graph, not its structure"). Edges connect the flow's
 * ordered `steps` by step_id. Kind is derived from EVIDENCE the CAS already
 * carries — never fabricated:
 *   - 'sequence'     — default ordering (step i → step i+1); the honest backbone
 *                      when no stronger evidence exists.
 *   - 'branch'       — the FROM step has a conditional control-flow successor
 *                      (a call edge flagged metadata.conditional, or a
 *                      method_call whose execution_context.is_conditional set).
 *   - 'error'        — the TO step is on a throw/catch path: it carries an
 *                      already-computed kind:'error' constraint (reuses the
 *                      error-contract evidence). Transitioning here enters
 *                      error-handling territory.
 *   - 'compensation' — the FROM step is itself on an error path AND the TO step
 *                      reverts state (a data_entities.lifecycle.deleted_by node
 *                      runs in it) — a rollback/cleanup after a failure edge.
 */
export type FlowEdgeKind = 'sequence' | 'branch' | 'error' | 'compensation';

export interface FlowStepEdge {
  from_step_id: string;
  to_step_id: string;
  kind: FlowEdgeKind;
  /** The concrete CAS fact that upgraded this edge above 'sequence' (the
   *  conditional edge/call, the error-constraint evidence, the state-revert
   *  signal). Omitted for a plain 'sequence' backbone edge — never fabricated. */
  evidence?: string;
}

export interface FlowStepGraph {
  /** Backbone edges over the flow's ordered `steps` (which remain the default
   *  human PROJECTION). One edge per consecutive step pair, its kind upgraded
   *  from 'sequence' to branch/error/compensation where evidence exists. A flow
   *  with no branch/error/compensation evidence is just the sequence chain —
   *  honest, not fabricated. */
  edges: FlowStepEdge[];
}

export interface FlowConcept {
  flow_id: string;
  name: string;
  intent: string;
  /** Interpretive flow-level description. ONLY ever populated by the AI
   *  enrichment pass (query layer joins the persisted element-description
   *  store) — omitted otherwise, never fabricated. `intent` remains the
   *  deterministic fact-shaped fallback. */
  description?: string;
  description_source?: 'ai';
  entry_point: string;
  /** BACK-COMPAT single link: the PRIMARY relationship's capability when one
   *  exists (= the first capability whose operations reference this flow's
   *  entry point). `capability_relationships` is the real model — M:N with
   *  the role on the edge; this stays populated so existing consumers keep
   *  working. Omitted (not fabricated) when no primary relationship exists. */
  capability_id?: string;
  /** ALL capability↔flow relationship edges for this flow (M:N — a flow may
   *  relate to multiple capabilities with different roles). Deterministic
   *  derivation (see CapabilityFlowRole); each edge carries the structural
   *  evidence in `rationale`. Omitted (never []) when no capability relates
   *  to this flow by operation ref or entity overlap. */
  capability_relationships?: CapabilityFlowRelationship[];
  /** Data entities the flow's functions read or write (by name), from
   *  data_lineage membership across all of the flow's functions. */
  entities: string[];
  /** Flow-level I/L/S/O + Constraints, aggregated over steps. */
  contract: ILSOContract;
  steps: FlowStep[];
  /**
   * The TERMINAL this flow is anchored on — what the system actually produces
   * at the end of this chain (the exit point the pre-computed entry-to-exit
   * call chain ends at). Present only for flows derived from a real terminal
   * call chain (buildTerminalFlows); omitted for entry-point-rooted flows that
   * have no resolved exit terminus. This is the deterministic answer to "why
   * this flow exists" — it ends by writing a store, calling an integration, or
   * emitting a response. */
  terminus?: {
    /** exit_point id (resolves in cas.exit_points). */
    exit_point_id: string;
    /** api | database | sdk | webhook | event | navigation | … (exit type). */
    kind: string;
    /** The produced target — service_id / resource / route / method name. */
    produces: string;
    /** The node at the terminus (last node on the chain that emits the exit). */
    node_id: string;
  };
  /** The flow's semantic STEP GRAPH over `steps` — branches, error paths, and
   *  compensations layered on the sequence backbone (docs/SEMANTIC-MODEL.md:
   *  the ordered `steps` list is a PROJECTION of this graph). Deterministic,
   *  evidence-gated. Omitted when the flow has <2 steps (no edge to draw). */
  step_graph?: FlowStepGraph;
  /** Flow ids this flow CONTINUES INTO via an async handoff: this flow's
   *  terminus is a publish/emit whose channel matches a consumer flow's entry
   *  point — a continuation segment of the SAME end-to-end flow, not a new flow
   *  (docs/SEMANTIC-MODEL.md: "Async continuation ≠ new flow"). Evidence-gated
   *  on a real publish↔consume seam match; omitted (never []) when none. */
  continuations?: string[];
  /** Back-ref of `continuations`: flow ids that CONTINUE INTO this flow (this
   *  flow is the async consumer they hand off to). Omitted when none. */
  continued_from?: string[];
  /** True when this flow is a reusable continuation segment — a consumer reached
   *  by an async publish from ≥1 other flow (it has `continued_from`). Omitted
   *  (never false) otherwise. */
  is_subflow?: boolean;
  /** Honest caveats about this specific flow's segmentation/derivation. */
  gaps?: string[];
}

export interface ComputeFlowConceptsOptions {
  /** Bound on forward call-chain traversal depth from the entry point. */
  maxDepth?: number;
  /** Cap on number of distinct functions traced per flow (dedupe applies). */
  maxFunctionsPerFlow?: number;
  /** Cap on number of flows returned (one per entry point, by default all). */
  maxFlows?: number;
  /** Restrict to entry points matching this id, name, or route path substring. */
  target?: string;
  /**
   * Optional AI/naming hook: given a deterministic step (already named),
   * may return a replacement name/description. Never called for anything
   * else — segmentation, I/L/S/O aggregation, constraint extraction, and
   * function refs are always deterministic. Fully inert (no-op) when
   * omitted.
   */
  nameStep?: (step: FlowStep, ctx: { flowEntryPoint: CASEntryPoint }) => { name?: string; description?: string } | undefined;
}

type StepCharacter = 'validate' | 'logic' | 'persist' | 'external' | 'respond';

export interface ChainNode {
  node: CASNode;
  depth: number;
}

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_FUNCTIONS = 40;

export const TRACEABLE_NODE_TYPES = new Set([
  'function', 'method', 'controller', 'handler', 'route', 'resolver', 'gateway',
  'service', 'usecase', 'repository', 'dao',
  // frontend / SPA route->view chains (reached via 'renders'/'uses' edges):
  // a react_route renders a functional_component/component, which uses hook
  // nodes (useQuery/useMutation are the actual data-fetch/persist step —
  // this is where the flow's real side effects live in a React app).
  'react_route', 'component', 'functional_component', 'class_component', 'page', 'view',
  'hook_usage', 'hook',
]);

const VALIDATE_NAME_RE = /\b(validate|guard|check|assert|sanitize|verify|authoriz|authentic)/i;
const RESPOND_NAME_RE = /\b(respond|render|reply|serialize|format|toJson|toResponse|present)/i;

/**
 * Classify a function node's dominant side-effect character using facts
 * already on the CAS: its own exit_points (by source_node), whether it
 * writes/reads a data_lineage entity, and a light name-based fallback for
 * validate/respond framing (the same kind of name-signal capability-detector
 * already relies on for semantic grouping — not a new heuristic category).
 */
function classifyStepCharacter(
  node: CASNode,
  exitPointsByNode: Map<string, CASExitPoint[]>,
  lineageByNode: Map<string, { writes: CASEntityLineage[]; reads: CASEntityLineage[] }>
): StepCharacter {
  const ownExits = exitPointsByNode.get(node.id) || [];
  const lineage = lineageByNode.get(node.id);

  if (ownExits.some(ep => ep.type === 'database' || ep.type === 'cache')) return 'persist';
  if (lineage && lineage.writes.length > 0) return 'persist';
  if (ownExits.some(ep => ['api', 'webhook', 'sdk', 'message', 'event', 'analytics'].includes(ep.type))) return 'external';
  if (VALIDATE_NAME_RE.test(node.name)) return 'validate';
  if (RESPOND_NAME_RE.test(node.name)) return 'respond';
  return 'logic';
}

const CHARACTER_LABEL: Record<StepCharacter, string> = {
  validate: 'Validate',
  logic: 'Process',
  persist: 'Persist',
  external: 'Call',
  respond: 'Respond',
};

/** Layer used as a secondary segmentation boundary (in addition to side-effect
 *  character): a jump between architectural layers is itself a step boundary
 *  even when the side-effect character doesn't change (e.g. controller ->
 *  service, both "logic", still worth separating as distinct semantic units
 *  when the node `category`/`type` signals a layer change). */
export function layerOf(node: CASNode): string {
  if (node.category) return node.category;
  if (['controller', 'handler', 'route', 'resolver', 'gateway', 'react_route'].includes(node.type)) return 'entry';
  if (['repository', 'dao', 'model'].includes(node.type)) return 'data';
  if (['service', 'usecase', 'interactor'].includes(node.type)) return 'business';
  if (['component', 'functional_component', 'class_component', 'page', 'view'].includes(node.type)) return 'presentation';
  if (['hook_usage', 'hook'].includes(node.type)) return 'business';
  return 'unknown';
}

/** Prebuilt forward-traversal index over the CAS graph, so callers that trace
 *  many roots (union path, entry-family entity rollup) build the O(edges)
 *  adjacency maps ONCE instead of once per root. */
export interface TraversalIndex {
  nodesById: Map<string, CASNode>;
  outgoingEdges: Map<string, CASEdge[]>;
  outgoingMethodCalls: Map<string, string[]>;
}

export function buildTraversalIndex(cas: CASOutput): TraversalIndex {
  const nodesById = new Map(cas.nodes.map(n => [n.id, n]));
  // Traversable edge kinds: function-call edges (backend/service chains) AND
  // 'renders'/'uses' (frontend route -> component chains, e.g. React Router
  // handler nodes are 'react_route' entities connected to their view via
  // 'renders', not a call edge). Both are "how the flow moves forward" —
  // segmentation still only fires on side-effect/layer character, so this
  // does not change what counts as a step boundary, only what is reachable.
  const TRAVERSABLE_EDGE_TYPES = new Set(['renders', 'uses']);
  const outgoingEdges = new Map<string, CASEdge[]>();
  for (const edge of cas.edges) {
    const traversable = edge.type === 'calls' || edge.type === 'invokes' || edge.type.includes('call') || TRAVERSABLE_EDGE_TYPES.has(edge.type);
    if (!traversable) continue;
    if (!outgoingEdges.has(edge.source)) outgoingEdges.set(edge.source, []);
    outgoingEdges.get(edge.source)!.push(edge);
  }
  const outgoingMethodCalls = new Map<string, string[]>();
  for (const mc of cas.method_calls || []) {
    if (!mc.caller_node || !mc.target_node) continue;
    if (!outgoingMethodCalls.has(mc.caller_node)) outgoingMethodCalls.set(mc.caller_node, []);
    outgoingMethodCalls.get(mc.caller_node)!.push(mc.target_node);
  }
  return { nodesById, outgoingEdges, outgoingMethodCalls };
}

/**
 * Trace the forward call chain from an entry point's handler node, bounded
 * by depth, deduped by node id (a diamond-shaped call graph must not be
 * walked twice or produce duplicate steps).
 */
export function traceForwardChain(
  index: TraversalIndex,
  rootId: string,
  maxDepth: number,
  maxFunctions: number
): ChainNode[] {
  const { nodesById, outgoingEdges, outgoingMethodCalls } = index;

  const visited = new Set<string>([rootId]);
  const chain: ChainNode[] = [];
  const rootNode = nodesById.get(rootId);
  if (rootNode) chain.push({ node: rootNode, depth: 0 });

  // BFS to preserve call-order-ish breadth-first ordering; ties broken by
  // discovery order (stable, deterministic).
  let frontier: string[] = [rootId];
  let depth = 0;
  while (frontier.length > 0 && depth < maxDepth && chain.length < maxFunctions) {
    const next: string[] = [];
    for (const id of frontier) {
      const targets = [
        ...(outgoingEdges.get(id) || []).map(e => e.target),
        ...(outgoingMethodCalls.get(id) || []),
      ];
      for (const targetId of targets) {
        if (visited.has(targetId)) continue;
        const targetNode = nodesById.get(targetId);
        if (!targetNode) continue;
        // only trace through callable/renderable node types — skip data/type
        // nodes that are call-graph noise, not semantic flow steps. Includes
        // frontend route/component types (react_route, component, page) so
        // SPA route->view chains are traceable via 'renders'/'uses' edges,
        // not just backend call chains.
        if (!TRACEABLE_NODE_TYPES.has(targetNode.type)) continue;
        visited.add(targetId);
        next.push(targetId);
        chain.push({ node: targetNode, depth: depth + 1 });
        if (chain.length >= maxFunctions) break;
      }
      if (chain.length >= maxFunctions) break;
    }
    frontier = next;
    depth++;
  }

  return chain;
}

/**
 * Segment a traced chain into cohesive steps: draw a boundary whenever the
 * side-effect CHARACTER changes, or the architectural LAYER changes. A run
 * of contiguous nodes with the same (character, layer) pair is one step.
 */
function segmentIntoSteps(
  chain: ChainNode[],
  exitPointsByNode: Map<string, CASExitPoint[]>,
  lineageByNode: Map<string, { writes: CASEntityLineage[]; reads: CASEntityLineage[] }>
): Array<{ character: StepCharacter; layer: string; nodes: CASNode[] }> {
  const segments: Array<{ character: StepCharacter; layer: string; nodes: CASNode[] }> = [];

  for (const { node } of chain) {
    const character = classifyStepCharacter(node, exitPointsByNode, lineageByNode);
    const layer = layerOf(node);
    const last = segments[segments.length - 1];
    if (last && last.character === character && last.layer === layer) {
      last.nodes.push(node);
    } else {
      segments.push({ character, layer, nodes: [node] });
    }
  }

  return segments;
}

/**
 * SUB-SECTION detection: within a single large function whose body spans
 * multiple side-effect phases, split it into contiguous line-range sections
 * using guard-clause / assignment / call boundaries visible in raw source —
 * a lightweight, deterministic line-scan (no re-parse), only attempted when
 * the node's own raw source is present and long enough to plausibly contain
 * more than one phase. Conservative: emits at most a validate-prefix split
 * (early guard clauses) followed by the remaining body, since that is the
 * one sub-section boundary derivable from text alone without a real AST
 * walk of the function body. Never fabricates line ranges — omitted when
 * `source.raw`/`source.line`/`source.end_line` aren't all present.
 */
function detectSubSections(
  node: CASNode
): Array<{ start_line: number; end_line: number; label: string }> | undefined {
  const raw = node.source?.raw;
  const startLine = node.source?.line;
  const endLine = node.source?.end_line;
  if (!raw || !startLine || !endLine || endLine <= startLine) return undefined;
  if (endLine - startLine < 6) return undefined; // too small to sub-section meaningfully

  const lines = raw.split('\n');
  if (lines.length < 6) return undefined;

  // find the last contiguous leading guard-clause line (if/throw/return-early
  // pattern) starting from the top of the body.
  let lastGuardLineIdx = -1;
  const GUARD_RE = /\b(if|throw|require|assert)\s*\(/;
  const RETURN_EARLY_RE = /\breturn\b/;
  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    const line = lines[i];
    if (GUARD_RE.test(line) || (RETURN_EARLY_RE.test(line) && i < 15)) {
      lastGuardLineIdx = i;
    } else if (lastGuardLineIdx >= 0 && line.trim() !== '' && !line.trim().startsWith('}') && !line.trim().startsWith('//')) {
      // first substantive non-guard line after guards seen — stop scanning.
      break;
    }
  }
  if (lastGuardLineIdx < 0 || lastGuardLineIdx >= lines.length - 2) return undefined;

  const guardEndLine = startLine + lastGuardLineIdx;
  return [
    { start_line: startLine, end_line: guardEndLine, label: 'guard clauses' },
    { start_line: guardEndLine + 1, end_line: endLine, label: 'body' },
  ];
}

/** Dominant terminal-entity name touched by a step's functions, via
 *  data_lineage writer/reader membership — used only for step naming. */
function dominantEntityForNodes(
  nodeIds: Set<string>,
  lineage: CASEntityLineage[]
): string | undefined {
  const counts = new Map<string, number>();
  for (const entry of lineage) {
    const touches = [...entry.writers, ...entry.readers].some(a => nodeIds.has(a.node_id));
    if (touches) counts.set(entry.entity_name, (counts.get(entry.entity_name) || 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

function externalServiceForNodes(nodeIds: Set<string>, exitPointsByNode: Map<string, CASExitPoint[]>): string | undefined {
  for (const id of nodeIds) {
    const eps = exitPointsByNode.get(id) || [];
    const ext = eps.find(ep => ['api', 'webhook', 'sdk'].includes(ep.type));
    if (ext) return ext.target?.service_id || ext.target?.sdk || ext.name;
  }
  return undefined;
}

function nameStepDeterministically(
  character: StepCharacter,
  nodes: CASNode[],
  exitPointsByNode: Map<string, CASExitPoint[]>,
  lineage: CASEntityLineage[]
): { name: string; description: string } {
  const nodeIds = new Set(nodes.map(n => n.id));
  const label = CHARACTER_LABEL[character];

  if (character === 'persist') {
    const entity = dominantEntityForNodes(nodeIds, lineage);
    const name = entity ? `Persist ${entity}` : 'Persist Data';
    return { name, description: entity
      ? `Writes ${entity} to storage (${nodes.map(n => n.name).join(', ')}).`
      : `Persists state via ${nodes.map(n => n.name).join(', ')}.` };
  }
  if (character === 'external') {
    const service = externalServiceForNodes(nodeIds, exitPointsByNode);
    const name = service ? `Call ${service}` : 'Call External Service';
    return { name, description: service
      ? `Calls external service ${service} via ${nodes.map(n => n.name).join(', ')}.`
      : `Reaches outside the process via ${nodes.map(n => n.name).join(', ')}.` };
  }
  if (character === 'validate') {
    return { name: 'Validate Request', description: `Guards/validates input via ${nodes.map(n => n.name).join(', ')}.` };
  }
  if (character === 'respond') {
    return { name: 'Respond', description: `Formats/returns the result via ${nodes.map(n => n.name).join(', ')}.` };
  }
  const entity = dominantEntityForNodes(nodeIds, lineage);
  const name = entity ? `Process ${entity}` : `${label} (${nodes[0]?.name || 'step'})`;
  return { name, description: `Core logic via ${nodes.map(n => n.name).join(', ')}.` };
}

function buildLineageIndex(cas: CASOutput): Map<string, { writes: CASEntityLineage[]; reads: CASEntityLineage[] }> {
  const index = new Map<string, { writes: CASEntityLineage[]; reads: CASEntityLineage[] }>();
  for (const entry of cas.data_lineage || []) {
    for (const w of entry.writers) {
      if (!index.has(w.node_id)) index.set(w.node_id, { writes: [], reads: [] });
      index.get(w.node_id)!.writes.push(entry);
    }
    for (const r of entry.readers) {
      if (!index.has(r.node_id)) index.set(r.node_id, { writes: [], reads: [] });
      index.get(r.node_id)!.reads.push(entry);
    }
  }
  return index;
}

/** Map every REAL entry point's id → its handler NODE id. Interior capability↔
 *  flow matching (deriveCapabilityRelationships) consults this to resolve a
 *  capability operation's `entry_point_id` to the node it anchors on, gated to
 *  genuine entry-point handlers so utility node refs can never over-link. */
function buildEntryHandlerNodeIdByEpId(cas: CASOutput): Map<string, string> {
  const index = new Map<string, string>();
  for (const ep of cas.entry_points || []) {
    index.set(ep.id, ep.handler?.node_id || ep.source_node);
  }
  return index;
}

function buildExitPointIndex(cas: CASOutput): Map<string, CASExitPoint[]> {
  const index = new Map<string, CASExitPoint[]>();
  for (const ep of cas.exit_points || []) {
    if (!index.has(ep.source_node)) index.set(ep.source_node, []);
    index.get(ep.source_node)!.push(ep);
  }
  return index;
}

/** Constraints from a node's own raw source: guard clauses, throws, asserts,
 *  and require()-style gating conditionals, translated into a plain-English
 *  business rule where the condition is legible, or the raw guarded
 *  condition text otherwise. Deterministic text-pattern extraction only —
 *  never invents rules that aren't textually present. */
function extractConstraintsFromSource(node: CASNode): FacetConstraint[] {
  const raw = node.source?.raw;
  if (!raw) return [];
  const out: FacetConstraint[] = [];
  const seen = new Set<string>();
  const push = (kind: ConstraintKind, rule: string, evidence: string) => {
    if (seen.has(rule)) return;
    seen.add(rule);
    out.push({ kind, rule, evidence });
  };

  // require(expr) / assert(expr) -> "expr" as a stated invariant.
  const callGuardRe = /\b(?:require|assert)\s*\(\s*([^,)]+?)\s*(?:,|\))/g;
  let m: RegExpExecArray | null;
  while ((m = callGuardRe.exec(raw))) {
    const expr = m[1].trim();
    if (expr) push('business-rule', `must satisfy: ${expr}`, m[0].trim());
  }

  // if (!cond) throw ... -> "cond must hold" (negated guard -> positive rule).
  const negatedThrowRe = /if\s*\(\s*!\s*([^)]+?)\s*\)\s*(?:\{[^}]*)?throw/g;
  while ((m = negatedThrowRe.exec(raw))) {
    const cond = m[1].trim();
    if (cond) push('business-rule', `must hold: ${cond}`, m[0].trim());
  }

  // if (cond) throw ... (direct gating conditional guarding via throw).
  const directThrowRe = /if\s*\(\s*([^)!][^)]*?)\s*\)\s*(?:\{[^}]*)?throw/g;
  while ((m = directThrowRe.exec(raw))) {
    const cond = m[1].trim();
    if (cond) push('business-rule', `must NOT hold: ${cond}`, m[0].trim());
  }

  return out;
}

/** Constraints derivable from CAS structural facts rather than raw-source
 *  text: entry-point security guards/roles, entry-point input validation
 *  rules, and data-entity invariants whose enforced_by includes a node in
 *  this step. All are already-computed facts (never inferred here). */
function extractStructuralConstraints(
  nodeIds: Set<string>,
  cas: CASOutput,
  ownEntryPoints: CASEntryPoint[],
  exitPointsByNode: Map<string, CASExitPoint[]>,
  scopeEntryPointIds?: Set<string>
): FacetConstraint[] {
  const out: FacetConstraint[] = [];
  const seen = new Set<string>();
  const push = (kind: ConstraintKind, rule: string, evidence: string) => {
    const key = `${kind}::${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, rule, evidence });
  };

  // --- Auth constraints (auth analyzer -> entry_point.security). ---
  for (const ep of ownEntryPoints) {
    if (ep.security?.authenticated) {
      push('auth', 'caller must be authenticated', `entry point "${ep.name}" security.authenticated=true`);
    }
    for (const role of ep.security?.authorized_roles || ep.security?.roles || []) {
      push('auth', `caller must have role: ${role}`, `entry point "${ep.name}" security.roles`);
    }
    for (const guard of ep.security?.guards || []) {
      push('auth', `guarded by: ${guard}`, `entry point "${ep.name}" security.guards`);
    }
    // --- Validation constraints (validation-schema analyzer -> input.validation). ---
    for (const rule of ep.input?.validation || []) {
      push('validation', rule, `entry point "${ep.name}" input.validation`);
    }
    // --- Rate-limit constraints, when the entry point security surfaces one. ---
    const rateLimit = (ep.security as any)?.rate_limit ?? (ep as any)?.rate_limit;
    if (rateLimit) {
      push('rate-limit', `rate limited: ${typeof rateLimit === 'string' ? rateLimit : JSON.stringify(rateLimit)}`,
        `entry point "${ep.name}" rate_limit`);
    }
  }

  // --- Data-entity invariants enforced by a node in this unit. ---
  for (const entity of cas.data_entities || []) {
    for (const inv of entity.invariants || []) {
      if (inv.enforced_by.some(id => nodeIds.has(id))) {
        push('invariant', inv.description, `data_entity "${entity.name}" invariant enforced_by a node in this unit`);
      }
    }
  }

  // --- Consistency / CAP constraints: if any exit point of this unit reads
  //     from a store that the consistency model tagged eventual / staleness-
  //     risky, that is a real correctness constraint ("reads here may be
  //     stale"). Evidence-gated by ref_id match against this unit's exits. ---
  const consistency = cas.consistency_model;
  if (consistency) {
    const ownExitIds = new Set<string>();
    for (const id of nodeIds) {
      for (const ep of exitPointsByNode.get(id) || []) ownExitIds.add(ep.id);
    }
    for (const sc of consistency.store_consistency || []) {
      if (!sc.consistency.staleness_risk) continue; // strong primary reads carry no staleness constraint.
      if (!ownExitIds.has(sc.ref_id)) continue;      // only when THIS unit's own exit reads that store.
      const cap = sc.consistency.cap_lean ? ` (${sc.consistency.cap_lean})` : '';
      push('consistency', `reads from ${sc.store} are eventually consistent${cap} — may observe stale data`,
        sc.consistency.evidence);
    }
    // Passive seams whose reader side is one of this unit's nodes: the landed
    // data is eventual by construction (replica / CDC / sink / materialized).
    for (const seam of consistency.passive_seams || []) {
      if (!nodeIds.has(seam.target)) continue;
      push('consistency', `reads via ${seam.channel} (${seam.shared_resource}) are eventually consistent — may lag the source`,
        seam.evidence);
    }
  }

  // --- Error / failure-mode constraints (kind: 'error'). Derived from the same
  //     CAS primitives get_error_contracts (query.ts getErrorContracts) reads —
  //     node.signature.throws + call_chains — but scoped to THIS unit's own
  //     nodes. Evidence-gated: only emitted when the fact NAMES one of this
  //     unit's nodes (throws declared on the node, or an uncaught propagation
  //     path that traverses the node). Never a generic "may throw". ---
  for (const c of extractErrorConstraints(nodeIds, cas, scopeEntryPointIds)) push(c.kind, c.rule, c.evidence);

  return out;
}

/** Failure-mode constraints for a unit (kind: 'error'). Pure static pass over
 *  the CAS primitives — never imports the app / query layer. Reads exactly the
 *  facts get_error_contracts derives from:
 *    - node.signature.throws           -> "throws <ErrorType>"
 *    - call_chains traversing the node -> "uncaught path to entry point <X>"
 *  and gates every emission on one of THIS unit's own node ids being named by
 *  the fact (declaring node for throws; a call_path step's node_id for paths).
 *  A node that neither declares a throw nor lies on a throwing chain yields
 *  nothing — no fabrication, no generic "may throw". */
function extractErrorConstraints(
  nodeIds: Set<string>,
  cas: CASOutput,
  /** When building a FLOW/STEP contract, the flow's own entry point ids.
   *  Uncaught-path constraints are then scoped to chains rooted at THIS
   *  flow's entry — a shared helper (e.g. a storage loader) sits on chains
   *  reaching hundreds of OTHER entry points, and those paths are not part
   *  of this flow's contract (measured live: 106 cross-entry constraints ≈
   *  29KB duplicated per flow+step before scoping). Absent scope keeps the
   *  unit-level behavior (a function's error contract spans all entries). */
  scopeEntryPointIds?: Set<string>
): FacetConstraint[] {
  const out: FacetConstraint[] = [];
  const seen = new Set<string>();
  const push = (rule: string, evidence: string) => {
    if (seen.has(rule)) return;
    seen.add(rule);
    out.push({ kind: 'error', rule, evidence });
  };

  // "throws <ErrorType>" — only for nodes in THIS unit that declare throws.
  const throwingHere = new Set<string>();
  for (const node of cas.nodes || []) {
    if (!nodeIds.has(node.id)) continue;
    for (const errorType of node.signature?.throws || []) {
      throwingHere.add(node.id);
      push(`throws ${errorType}`, `node "${node.name}" signature.throws includes ${errorType}`);
    }
  }

  // "uncaught path to entry point <X>" — a call chain whose path traverses one
  // of this unit's throwing nodes AND does not surface a caught-here handler
  // for it. We only assert the path when the throwing node is on the chain
  // (the fact names the node), mirroring getErrorContracts' uncaught_paths.
  if (throwingHere.size > 0) {
    for (const chain of cas.call_chains || []) {
      // Flow/step scope: only chains rooted at this flow's own entry point.
      if (scopeEntryPointIds && scopeEntryPointIds.size > 0) {
        const chainEp = chain.entry_point.entry_point_id || chain.entry_point.node_id;
        if (!scopeEntryPointIds.has(chainEp) && !scopeEntryPointIds.has(chain.entry_point.node_id)) continue;
      }
      const throwerOnPath = (chain.call_path || []).find(step => throwingHere.has(step.node_id));
      if (!throwerOnPath) continue;
      // Evidence-gated caught check: a try-catch pattern instance on a node that
      // sits on this chain downstream of / at the thrower means the error is
      // handled — do not report it as uncaught.
      const chainNodeIds = new Set((chain.call_path || []).map(s => s.node_id));
      const caughtOnChain = (cas.patterns || []).some(p =>
        p.name.toLowerCase().includes('try-catch') &&
        (p.instances || []).some(id => chainNodeIds.has(id))
      );
      if (caughtOnChain) continue;
      const epId = chain.entry_point.entry_point_id || chain.entry_point.node_id;
      const epName = (cas.entry_points || []).find(ep => ep.id === epId)?.name
        || chain.entry_point.method_name || epId;
      push(`uncaught path to entry point ${epName}`,
        `call chain ${chain.id} traverses throwing node "${throwerOnPath.method_name}" and reaches entry point ${epName} with no try-catch on the path`);
    }
  }

  // Defensive size cap for any unscoped caller: a widely-shared throwing
  // helper can otherwise emit one constraint per reachable entry point.
  // Keep the deterministic first N and summarize the rest honestly.
  const ERROR_CONSTRAINT_CAP = 12;
  if (out.length > ERROR_CONSTRAINT_CAP) {
    const dropped = out.length - ERROR_CONSTRAINT_CAP;
    const capped = out.slice(0, ERROR_CONSTRAINT_CAP);
    capped.push({
      kind: 'error',
      rule: `+${dropped} more uncaught-throw paths (truncated)`,
      evidence: `${dropped} additional error constraints of the same shape were derived; truncated to keep the contract readable`,
    });
    return capped;
  }
  return out;
}

/** Build the ILSOContract for a set of functions (a step, or the whole flow
 *  when aggregating). Reuses the same fact sources getInterfaceSignature
 *  joins in query.ts: params/entry_points for input, return types +
 *  produced entities for output, exit_points + data_lineage external
 *  recipients for side_effects.external_integrations, data_lineage writes
 *  for side_effects.state_changes, and guard/validation/invariant facts for
 *  constraints — applied over a SET of functions instead of one node. */
function buildContract(
  nodes: CASNode[],
  cas: CASOutput,
  exitPointsByNode: Map<string, CASExitPoint[]>,
  entryPointsByNode: Map<string, CASEntryPoint[]>,
  /** The owning flow's entry point ids — scopes error constraints to THIS
   *  flow's chains (see extractErrorConstraints). */
  scopeEntryPointIds?: Set<string>
): ILSOContract {
  const input = new Set<string>();
  const output = new Set<string>();
  const stateChanges = new Set<string>();
  const externalIntegrations = new Set<string>();
  const constraints: FacetConstraint[] = [];
  const constraintKeys = new Set<string>();
  const addConstraint = (c: FacetConstraint) => {
    const key = `${c.kind}::${c.rule}`;
    if (constraintKeys.has(key)) return;
    constraintKeys.add(key);
    constraints.push(c);
  };

  const nodeIds = new Set(nodes.map(n => n.id));

  for (const node of nodes) {
    for (const p of node.signature?.parameters || []) {
      input.add(p.type ? `${p.name}: ${p.type}` : p.name);
    }
    if (node.signature?.return_type) output.add(node.signature.return_type);

    for (const ep of exitPointsByNode.get(node.id) || []) {
      const label = ep.target?.service_id || ep.target?.resource || `${ep.type}:${ep.name}`;
      if (ep.type === 'database' || ep.type === 'cache' || ep.type === 'file') {
        stateChanges.add(label);
      } else {
        externalIntegrations.add(label);
      }
    }

    for (const c of extractConstraintsFromSource(node)) addConstraint(c);
  }

  // entity-level side effects (writes/reads), named by entity rather than by
  // accessor node id, joined the same way getInterfaceSignature does via
  // data_lineage external_recipients. writes -> state_changes; recipients
  // external to the process -> external_integrations.
  for (const entry of cas.data_lineage || []) {
    const writesHere = entry.writers.some(w => nodeIds.has(w.node_id));
    const readsHere = entry.readers.some(r => nodeIds.has(r.node_id));
    if (writesHere) stateChanges.add(`${entry.entity_name} updated`);
    if (readsHere) input.add(`reads ${entry.entity_name}`);
    if (writesHere || readsHere) {
      for (const rec of entry.external_recipients) externalIntegrations.add(rec.service);
    }
  }

  const ownEntryPoints = nodes.flatMap(n => entryPointsByNode.get(n.id) || []);
  for (const c of extractStructuralConstraints(nodeIds, cas, ownEntryPoints, exitPointsByNode, scopeEntryPointIds)) addConstraint(c);

  const logicNames = nodes.map(n => n.name);
  return {
    input: [...input],
    logic: logicNames.length > 1 ? logicNames.join(' -> ') : (logicNames[0] || ''),
    side_effects: {
      state_changes: [...stateChanges],
      external_integrations: [...externalIntegrations],
    },
    output: [...output],
    constraints,
  };
}

/** Aggregate step contracts up to a flow-level contract: union I/O/side
 *  effects/constraints, logic = ordered step name summary. */
function aggregateFlowContract(steps: FlowStep[]): ILSOContract {
  const input = new Set<string>();
  const output = new Set<string>();
  const stateChanges = new Set<string>();
  const externalIntegrations = new Set<string>();
  const constraints: FacetConstraint[] = [];
  const constraintKeys = new Set<string>();

  for (const step of steps) {
    for (const v of step.contract.input) input.add(v);
    for (const v of step.contract.output) output.add(v);
    for (const v of step.contract.side_effects.state_changes) stateChanges.add(v);
    for (const v of step.contract.side_effects.external_integrations) externalIntegrations.add(v);
    for (const c of step.contract.constraints) {
      const key = `${c.kind}::${c.rule}`;
      if (constraintKeys.has(key)) continue;
      constraintKeys.add(key);
      constraints.push(c);
    }
  }

  return {
    input: [...input],
    logic: steps.map(s => s.name).join(' -> '),
    side_effects: {
      state_changes: [...stateChanges],
      external_integrations: [...externalIntegrations],
    },
    output: [...output],
    constraints,
  };
}

/**
 * Data entities any node in `nodeIds` genuinely touches. Two independent CAS
 * signals are consulted — data_lineage (writers/readers keyed by node_id)
 * AND data_entities[].lifecycle (created_by/read_by/updated_by/deleted_by,
 * also keyed by node_id) — since either can carry membership the other
 * lacks depending on which analyzer pass populated it, and both already key
 * on the same node-id namespace as `cas.nodes` (verified: these are the
 * literal ids traceForwardChain visits, not a separate id scheme — no
 * cross-namespace translation is needed, only checking both sources so a
 * flow whose traced set intersects EITHER one is credited). Never attaches
 * an entity without a real touching node in `nodeIds` — no name-similarity,
 * no capability-co-membership shortcut.
 */
function entitiesForNodes(nodeIds: Set<string>, cas: CASOutput): string[] {
  const names = new Set<string>();
  for (const entry of cas.data_lineage || []) {
    const touches = [...entry.writers, ...entry.readers].some(a => nodeIds.has(a.node_id));
    if (touches) names.add(entry.entity_name);
  }
  for (const entity of cas.data_entities || []) {
    const touchers = [
      ...(entity.lifecycle?.created_by || []),
      ...(entity.lifecycle?.read_by || []),
      ...(entity.lifecycle?.updated_by || []),
      ...(entity.lifecycle?.deleted_by || []),
    ];
    if (touchers.some(id => nodeIds.has(id))) names.add(entity.name);
  }
  return [...names];
}

/**
 * Normalize an entity reference to a comparison key that reconciles the TWO
 * shapes the CAS uses for the SAME entity: the display NAME carried on
 * flow.entities (from data_lineage.entity_name / data_entities.name, e.g.
 * "WorkingMemorySession") and the ID carried on capability.related_entities
 * (e.g. "entity_workingmemorysession"). Without this reconciliation the path-(b)
 * overlap in deriveCapabilityRelationships compares "entity_workingmemorysession"
 * against "workingmemorysession" and NEVER matches — silently zeroing every
 * entity-overlap capability↔flow edge. Lowercases, strips a leading `entity_`
 * id-prefix, and drops non-alphanumerics so "WorkingMemorySession",
 * "working_memory_session", and "entity_workingmemorysession" all collapse to
 * one key. Deterministic, evidence-preserving (no fuzzy matching — exact key
 * equality after canonicalization).
 */
export function normalizeEntityKey(ref: string): string {
  return String(ref).toLowerCase().replace(/^entity_/, '').replace(/[^a-z0-9]/g, '');
}

/**
 * ENTRY-POINT-FAMILY entity rollup: the full forward-reachable node set from a
 * flow's root ("the route/handler's lineage"), used to attach entities the
 * flow genuinely reaches even when the specific recorded chain path missed the
 * write/read node (a terminal chain records ONE path; the handler's family
 * covers the sibling branches). Still evidence-gated — the entity must have a
 * real accessor node inside the traced family; no name-similarity, no
 * capability-co-membership shortcut. Memoized per root so many chains sharing
 * one handler pay for the BFS once.
 */
function makeEntryFamilyEntities(
  cas: CASOutput,
  index: TraversalIndex,
  maxDepth: number,
  maxFunctions: number
): (rootId: string | undefined) => string[] {
  const memo = new Map<string, string[]>();
  return (rootId: string | undefined): string[] => {
    if (!rootId) return [];
    const cached = memo.get(rootId);
    if (cached) return cached;
    const family = traceForwardChain(index, rootId, maxDepth, maxFunctions);
    const familyIds = new Set(family.map(c => c.node.id));
    familyIds.add(rootId);
    const entities = entitiesForNodes(familyIds, cas);
    memo.set(rootId, entities);
    return entities;
  };
}

/** Union of two entity-name lists, order-stable (first list wins ordering). */
function unionEntities(primary: string[], extra: string[]): string[] {
  if (extra.length === 0) return primary;
  const seen = new Set(primary);
  const out = [...primary];
  for (const name of extra) {
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

/** Exit-point kinds that ARE telemetry emission (exit-point TYPE facts from
 *  the CAS exit-point union — never a name pattern). 'analytics' is the only
 *  telemetry-shaped kind in EXIT_POINT_TYPES today; extend here if the union
 *  grows a metrics/log/trace kind. */
const TELEMETRY_EXIT_KINDS = new Set(['analytics']);

/** Whether a flow's observable exits are DOMINATED by telemetry exit kinds —
 *  the deterministic ground for an 'observability' capability relationship.
 *  Facts only: the flow's own nodes' exit points (by type) plus the resolved
 *  terminus kind. Dominated = the terminus itself is a telemetry exit, or
 *  strictly more telemetry exits than non-telemetry ones across the flow's
 *  nodes. Returns the concrete evidence string alongside the verdict. */
function telemetryExitDominance(
  nodeIds: Set<string>,
  exitPointsByNode: Map<string, CASExitPoint[]>,
  terminusKind?: string
): { dominated: boolean; evidence?: string } {
  const telemetry: CASExitPoint[] = [];
  let otherCount = 0;
  for (const id of nodeIds) {
    for (const ep of exitPointsByNode.get(id) || []) {
      if (TELEMETRY_EXIT_KINDS.has(ep.type)) telemetry.push(ep);
      else otherCount++;
    }
  }
  if (terminusKind && TELEMETRY_EXIT_KINDS.has(terminusKind)) {
    return { dominated: true, evidence: `flow terminus is a telemetry exit (kind '${terminusKind}')` };
  }
  if (telemetry.length > 0 && telemetry.length > otherCount) {
    const names = telemetry.slice(0, 3).map(e => e.name).join(', ');
    return {
      dominated: true,
      evidence: `${telemetry.length}/${telemetry.length + otherCount} of the flow's exit points are telemetry kinds (${names})`,
    };
  }
  return { dominated: false };
}

/**
 * Derive ALL capability↔flow relationship edges for one flow — DETERMINISTIC
 * (Camp-B), structural refs only, never name keywords:
 *
 *   (a) a capability operation references this flow's entry point
 *       (operations[].entry_point_id === entry-point id | `node:<root>` |
 *       root node id — the same three shapes deriveCapabilityOperationRoots
 *       documents) → 'primary'; rationale cites the operation ref.
 *   (b) the flow's touched entities overlap the capability's related_entities
 *       but its entry point is NOT among the capability's operations →
 *       'supporting'; rationale cites the shared entity names.
 *   (d) an entity-overlap edge on a flow whose exits are dominated by
 *       telemetry exit kinds → 'observability'; rationale cites the exit
 *       facts. (An operation ref still wins: realizing an operation of the
 *       capability is stronger evidence than the exit mix.)
 *
 * Rule (c) — entity-overlap edge + flow classified 'infrastructure' by the
 * semantic-role classifier → 'operational' — is applied at the QUERY layer
 * (applyFlowRoleToCapabilityRelationships), because the role classifier lives
 * there; this pure static pass never sees it.
 *
 * A flow may relate to MULTIPLE capabilities (one edge per capability, in
 * capabilities array order — stable run-to-run). Returns [] when nothing
 * relates; callers omit the field rather than serializing an empty array.
 */
function deriveCapabilityRelationships(args: {
  capabilities: SystemCapability[];
  /** Resolved cas.entry_points[].id for the flow root, when one exists. */
  entryPointId?: string;
  /** The flow root's handler node id (always known). */
  rootNodeId?: string;
  /** Entity names the flow's functions genuinely touch (entitiesForNodes). */
  entities: string[];
  /** Telemetry-dominance verdict for this flow (telemetryExitDominance). */
  telemetry: { dominated: boolean; evidence?: string };
  /** ALL node ids on the flow's traced path (root + every interior step) — lets
   *  a capability whose own entry-point handler is realized as an INTERIOR step
   *  of this larger flow link to it (→ supporting). Omitted → interior matching
   *  is skipped (behavior unchanged). */
  pathNodeIds?: Set<string>;
  /** Resolver from a capability operation's `entry_point_id` to the handler
   *  NODE id it anchors on, restricted to REAL entry points (cas.entry_points).
   *  Interior matching consults this so only a capability's genuine entry-point
   *  handler counts as an interior anchor — a utility/helper node a capability
   *  merely names is excluded, so a shared helper never blasts the edge across
   *  every flow that happens to traverse it. */
  entryHandlerNodeIdByEpId?: Map<string, string>;
}): CapabilityFlowRelationship[] {
  const { capabilities, entryPointId, rootNodeId, entities, telemetry, pathNodeIds, entryHandlerNodeIdByEpId } = args;
  const out: CapabilityFlowRelationship[] = [];
  const entityKeySet = new Set(entities.map(normalizeEntityKey));

  for (const cap of capabilities) {
    const opMatch = (cap.operations || []).find(op =>
      (entryPointId !== undefined && op.entry_point_id === entryPointId) ||
      (rootNodeId !== undefined && (op.entry_point_id === `node:${rootNodeId}` || op.entry_point_id === rootNodeId))
    );
    if (opMatch) {
      out.push({
        capability_id: cap.id,
        role: 'primary',
        rationale: `capability operation "${opMatch.action}" (entry_point_id=${opMatch.entry_point_id}) references this flow's entry point`,
      });
      continue;
    }

    // INTERIOR entry-point anchor: a capability whose OWN entry-point handler is
    // realized as a step on THIS flow's path (but is not the flow's root) — the
    // flow passes THROUGH that capability's entry point, so the capability is
    // 'supporting' to this flow. Evidence-gated to real entry-point handlers
    // (entryHandlerNodeIdByOpEp) — never a bare utility node ref — and stronger
    // than entity overlap, so it wins when both would fire.
    if (pathNodeIds && entryHandlerNodeIdByEpId) {
      const interiorOp = (cap.operations || []).find(op => {
        const handlerNodeId = entryHandlerNodeIdByEpId.get(op.entry_point_id);
        return handlerNodeId !== undefined
          && handlerNodeId !== rootNodeId
          && pathNodeIds.has(handlerNodeId);
      });
      if (interiorOp) {
        out.push({
          capability_id: cap.id,
          role: 'supporting',
          rationale: `capability operation "${interiorOp.action}" (entry_point_id=${interiorOp.entry_point_id}) is realized as an interior step on this flow's path`,
        });
        continue;
      }
    }

    const shared = (cap.related_entities || []).filter(name => entityKeySet.has(normalizeEntityKey(String(name))));
    if (shared.length === 0) continue;
    const sharedList = shared.join(', ');
    if (telemetry.dominated) {
      out.push({
        capability_id: cap.id,
        role: 'observability',
        rationale: `flow touches this capability's related entities (${sharedList}) and ${telemetry.evidence}`,
      });
    } else {
      out.push({
        capability_id: cap.id,
        role: 'supporting',
        rationale: `flow touches entities in this capability's related_entities (${sharedList}) but its entry point is not among the capability's operations`,
      });
    }
  }

  return out;
}

/**
 * Rule (c) of the capability↔flow role derivation, applied at the QUERY layer
 * where the semantic-role classifier (apps/mcp-server/src/semantic-roles.ts
 * classifyFlowRole) runs: a flow the classifier grounds as 'infrastructure'
 * (deploy/install script entry, plumbing surface) relates to a capability via
 * shared entities as 'operational', not 'supporting'. Only entity-overlap
 * edges flip — an operation ref ('primary') and telemetry dominance
 * ('observability') are stronger, more specific evidence and keep their role.
 * Mutates in place; a no-op for any other role / when no relationships exist.
 */
export function applyFlowRoleToCapabilityRelationships(
  flow: Pick<FlowConcept, 'capability_relationships'>,
  role: string | undefined,
  roleEvidence?: string[]
): void {
  if (role !== 'infrastructure' || !flow.capability_relationships) return;
  for (const rel of flow.capability_relationships) {
    if (rel.role !== 'supporting') continue;
    rel.role = 'operational';
    rel.rationale += `; flow classified 'infrastructure' by the semantic-role classifier${roleEvidence && roleEvidence.length ? ` (${roleEvidence[0]})` : ''}`;
  }
}

/** entry_point_type values on a capability operation don't necessarily line
 *  up with CASEntryPoint's stricter type union (e.g. 'internal' isn't a
 *  valid CASEntryPoint.type) — map to the closest real type, defaulting to
 *  the always-valid 'message' for anything unrecognized rather than
 *  fabricating a category. */
const CAPABILITY_ENTRY_TYPE_MAP: Record<string, CASEntryPoint['type']> = {
  http: 'http', websocket: 'websocket', cli: 'cli', event: 'event',
  schedule: 'schedule', page: 'page', route: 'route', message: 'message',
  file: 'file', test: 'test', lifecycle: 'lifecycle',
};

/**
 * Bridge gap: `cas.entry_points` is the flow-root source, but on backend
 * services whose route/controller entry points aren't (yet, or ever, for
 * some frameworks) surfaced there, `system_capabilities[].operations[]`
 * already names the real handler/method node directly via a `node:<id>`
 * reference — the CAS's own capability-detection pass already resolved
 * "what operation this is" against real nodes, independent of entry-point
 * extraction. When such an operation's node exists in the graph and isn't
 * already covered by a real entry_points root, synthesize a minimal
 * CASEntryPoint-shaped root for it so computeFlowConcepts can trace a flow
 * from it too — this is not a guess: the node id, and the capability that
 * names it, both come straight off the CAS. The synthesized id is tagged
 * `synthflow:` so it never collides with a real entry_points id, and the
 * flow's `gaps` records that its root was synthesized this way (honest, not
 * hidden).
 */
function deriveCapabilityOperationRoots(
  cas: CASOutput,
  capabilities: SystemCapability[],
  nodesById: Map<string, CASNode>,
  existingRootNodeIds: Set<string>
): Array<{ ep: CASEntryPoint; synthesized: true }> {
  const seen = new Set<string>();
  const roots: Array<{ ep: CASEntryPoint; synthesized: true }> = [];

  for (const cap of capabilities) {
    for (const op of cap.operations || []) {
      if (!op.entry_point_id.startsWith('node:')) continue; // only the direct-node-reference shape is a candidate root; plain ids already resolve via cas.entry_points.
      const nodeId = op.entry_point_id.slice('node:'.length);
      if (existingRootNodeIds.has(nodeId)) continue; // already traceable as a real entry point — no synthetic root needed.
      if (seen.has(nodeId)) continue;
      const node = nodesById.get(nodeId);
      if (!node) continue; // capability references a node id the CAS no longer has — never fabricate a root for it.
      if (!TRACEABLE_NODE_TYPES.has(node.type) && node.type !== 'method') continue;
      seen.add(nodeId);

      const type = CAPABILITY_ENTRY_TYPE_MAP[op.entry_point_type] || 'message';
      roots.push({
        synthesized: true,
        ep: {
          id: `synthflow:${nodeId}`,
          source_node: nodeId,
          type,
          name: node.name,
          description: `Operation "${op.action}" of capability "${cap.name}" (no dedicated entry_points root — traced directly from the capability's referenced node).`,
          trigger: op.path_or_command ? { pattern: op.path_or_command } : undefined,
          handler: { node_id: nodeId, method_name: node.name },
        },
      });
    }
  }

  return roots;
}

function flowNameForEntryPoint(ep: CASEntryPoint): string {
  if (ep.trigger?.path) {
    const parts = ep.trigger.path.split('/').filter(Boolean).filter(p => !p.startsWith(':') && !p.startsWith('{'));
    const last = parts[parts.length - 1] || ep.name;
    const words = last.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
    const title = words.split(' ').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    return title || ep.name;
  }
  const words = ep.name.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return words.split(' ').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || ep.name;
}

function flowIntentForEntryPoint(ep: CASEntryPoint): string {
  const method = ep.trigger?.method ? `${ep.trigger.method} ` : '';
  const path = ep.trigger?.path || ep.trigger?.pattern || ep.trigger?.event || ep.trigger?.schedule || '';
  const via = path ? `${method}${path}`.trim() : ep.name;
  return `Handles ${ep.type} entry "${via}"${ep.description ? `: ${ep.description}` : ''}`;
}

// ---------------------------------------------------------------------------
// STEP GRAPH (C1) — the ordered `steps` list is a PROJECTION of a step GRAPH
// (docs/SEMANTIC-MODEL.md, Flow). We layer branch/error/compensation edge kinds
// onto the sequence backbone, each gated on a fact the CAS already computed.
// ---------------------------------------------------------------------------

/** Node ids that make a CONDITIONAL control-flow successor — the deterministic
 *  ground for a 'branch' step-graph edge. Two already-computed CAS facts feed
 *  it: a call EDGE flagged `metadata.conditional`, and a method_call whose
 *  `execution_context.is_conditional` is set. Keyed by the SOURCE/caller node →
 *  the concrete evidence string. Facts only; a node with no conditional
 *  successor never appears (no fabrication). Computed once per CAS. */
function buildConditionalOutIndex(cas: CASOutput): Map<string, string> {
  const index = new Map<string, string>();
  for (const edge of cas.edges || []) {
    if (edge.metadata?.conditional === true && !index.has(edge.source)) {
      index.set(edge.source, `call edge ${edge.id} (${edge.source} -> ${edge.target}) is conditional (edge.metadata.conditional)`);
    }
  }
  for (const mc of cas.method_calls || []) {
    const caller = mc.caller_node;
    if (!caller || index.has(caller)) continue;
    if (mc.execution_context?.is_conditional) {
      const name = mc.call_details?.method_name || mc.target_node || '';
      index.set(caller, `method call ${name} from ${caller} is made in a conditional context (execution_context.is_conditional)`.replace(/\s+/g, ' ').trim());
    }
  }
  return index;
}

/** Node ids that DELETE an entity (data_entities.lifecycle.deleted_by) — the
 *  structural ground for a 'compensation' step (a state-reverting cleanup that
 *  follows a failure edge). Facts only. Computed once per CAS. */
function buildDeleterNodeIds(cas: CASOutput): Set<string> {
  const ids = new Set<string>();
  for (const entity of cas.data_entities || []) {
    for (const id of entity.lifecycle?.deleted_by || []) ids.add(id);
  }
  return ids;
}

/** Sane cap on step-graph edges (steps are already function-capped, so this is
 *  a defensive bound only — a pathological flow never emits an unbounded graph). */
const STEP_GRAPH_EDGE_CAP = 250;

/**
 * Build the step GRAPH for a flow: the sequence backbone (step i → step i+1),
 * each edge upgraded to branch/error/compensation where the CAS carries the
 * evidence. `segmentNodes[i]` are the nodes of `steps[i]` (aligned by index —
 * both come from the same `segments` array). Returns undefined for a <2-step
 * flow (no edge to draw). Deterministic: edges are in step order; each edge's
 * kind is chosen by a fixed precedence (compensation > error > branch >
 * sequence) so the same CAS yields byte-identical graphs run-to-run.
 */
function buildStepGraph(
  steps: FlowStep[],
  segmentNodes: CASNode[][],
  conditionalOut: Map<string, string>,
  deleterNodeIds: Set<string>
): FlowStepGraph | undefined {
  if (steps.length < 2) return undefined;
  const edges: FlowStepEdge[] = [];
  const limit = Math.min(steps.length - 1, STEP_GRAPH_EDGE_CAP);
  for (let i = 0; i < limit; i++) {
    const from = steps[i];
    const to = steps[i + 1];
    const fromNodes = segmentNodes[i] || [];
    const toNodes = segmentNodes[i + 1] || [];

    // error: the TO step is on a throw/catch path — reuse the already-computed
    // kind:'error' constraint (extractErrorConstraints), scoped to this flow.
    const toErr = to.contract.constraints.find(c => c.kind === 'error');
    // branch: any node in the FROM step has a conditional control-flow successor.
    let branchEv: string | undefined;
    for (const n of fromNodes) {
      const ev = conditionalOut.get(n.id);
      if (ev) { branchEv = ev; break; }
    }
    // compensation: the FROM step is itself on an error path AND the TO step
    // reverts state (a delete-lifecycle node runs in it) — a cleanup after the
    // failure. Structural + evidence-gated; deliberately conservative.
    const fromIsError = from.contract.constraints.some(c => c.kind === 'error');
    const revertsState = toNodes.some(n => deleterNodeIds.has(n.id));

    let kind: FlowEdgeKind = 'sequence';
    let evidence: string | undefined;
    if (fromIsError && revertsState) {
      kind = 'compensation';
      evidence = `follows an error-carrying step and reverts state (a data_entities.lifecycle.deleted_by node runs in "${to.name}")`;
    } else if (toErr) {
      kind = 'error';
      evidence = toErr.evidence;
    } else if (branchEv) {
      kind = 'branch';
      evidence = branchEv;
    }
    edges.push(evidence
      ? { from_step_id: from.step_id, to_step_id: to.step_id, kind, evidence }
      : { from_step_id: from.step_id, to_step_id: to.step_id, kind });
  }
  return { edges };
}

// ---------------------------------------------------------------------------
// ASYNC CONTINUATIONS (C1) — an event/message PUBLISH whose channel matches a
// CONSUMER entry point is a continuation of the SAME end-to-end flow (and the
// consumer is a reusable subflow). docs/SEMANTIC-MODEL.md: "Async continuation
// ≠ new flow". Evidence-gated on a real publish↔consume seam match.
// ---------------------------------------------------------------------------

/** Normalize an async channel/target string for publish↔consume matching.
 *  Lowercases, trims, strips surrounding quotes, drops non-alphanumerics so
 *  "order.created", "Order.Created", and "order_created" collapse to one key.
 *  Generic seam FALLBACK tokens ('external', 'channel') and single-char noise
 *  are treated as non-channels (→ '') so they can never stitch unrelated flows. */
function normalizeChannelKey(raw: string | undefined): string {
  if (raw === undefined || raw === null) return '';
  const trimmed = String(raw).trim().toLowerCase().replace(/^['"]+|['"]+$/g, '');
  if (trimmed === 'external' || trimmed === 'channel') return '';
  const key = trimmed.replace(/[^a-z0-9]/g, '');
  return key.length < 2 ? '' : key;
}

/**
 * Pair publisher EXIT points to consumer ENTRY points by matching channel keys —
 * the deterministic publish↔consume seam graph. Prefers the pre-computed
 * `cas.communication_seams` (the seam graph the deployable inventory already
 * builds — producer messaging seams carry `metadata.exit_point` + target=channel;
 * consumer messaging seams carry `metadata.entry_point` + source=channel), and
 * falls back to deriving the SAME pairing from `cas.exit_points` (message/event)
 * and `cas.entry_points` (message/event) when seams aren't populated. Either way
 * the evidence is a real publish-target ↔ consume-channel match. Returns
 * {exitId, entryId, channel} triples, sorted, deduped — never fabricated.
 */
function pairPublishConsumeSeams(cas: CASOutput): Array<{ exitId: string; entryId: string; channel: string }> {
  const pairs: Array<{ exitId: string; entryId: string; channel: string }> = [];
  const seen = new Set<string>();
  const add = (exitId: string, entryId: string, channel: string) => {
    if (!exitId || !entryId) return;
    const key = `${exitId}\u0000${entryId}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ exitId, entryId, channel });
  };

  // --- Preferred: the classified communication_seams graph. ---
  const seams = cas.communication_seams?.seams;
  if (seams && seams.length > 0) {
    const consumersByChannel = new Map<string, string[]>();
    for (const s of seams) {
      const entryId = (s.metadata as Record<string, unknown> | undefined)?.entry_point;
      if (s.kind !== 'messaging' || typeof entryId !== 'string') continue;
      const channel = normalizeChannelKey(s.source);
      if (!channel) continue;
      if (!consumersByChannel.has(channel)) consumersByChannel.set(channel, []);
      consumersByChannel.get(channel)!.push(entryId);
    }
    if (consumersByChannel.size > 0) {
      for (const s of seams) {
        const exitId = (s.metadata as Record<string, unknown> | undefined)?.exit_point;
        if (s.kind !== 'messaging' || typeof exitId !== 'string') continue;
        const channel = normalizeChannelKey(s.target);
        if (!channel) continue;
        for (const entryId of consumersByChannel.get(channel) || []) add(exitId, entryId, channel);
      }
      if (pairs.length > 0) {
        pairs.sort((a, b) => a.exitId.localeCompare(b.exitId) || a.entryId.localeCompare(b.entryId));
        return pairs;
      }
    }
  }

  // --- Fallback: derive the same pairing from the raw exit/entry facts. ---
  const consumersByChannel = new Map<string, string[]>();
  for (const ep of cas.entry_points || []) {
    if (ep.type !== 'message' && ep.type !== 'event') continue;
    const channel = normalizeChannelKey(ep.trigger?.event || ep.name);
    if (!channel) continue;
    if (!consumersByChannel.has(channel)) consumersByChannel.set(channel, []);
    consumersByChannel.get(channel)!.push(ep.id);
  }
  if (consumersByChannel.size === 0) return pairs;
  for (const exit of cas.exit_points || []) {
    if (exit.type !== 'message' && exit.type !== 'event') continue;
    const target = exit.target?.service_id || exit.target?.resource || exit.target?.endpoint || exit.name;
    const channel = normalizeChannelKey(target);
    if (!channel) continue;
    for (const entryId of consumersByChannel.get(channel) || []) add(exit.id, entryId, channel);
  }
  pairs.sort((a, b) => a.exitId.localeCompare(b.exitId) || a.entryId.localeCompare(b.entryId));
  return pairs;
}

/**
 * Stitch async continuations across the full flow set: when a flow's terminus
 * is an event/message PUBLISH whose channel matches a CONSUMER flow's entry
 * point (via pairPublishConsumeSeams), the publisher CONTINUES INTO the consumer
 * (`continuations`) and the consumer is a reusable subflow (`continued_from` +
 * `is_subflow`). Mutates in place; a no-op when there are <2 flows or no seam
 * pair matches. Deterministic: continuation lists are sorted, byte-stable.
 */
export function stitchContinuations(flows: FlowConcept[], cas: CASOutput): FlowConcept[] {
  if (flows.length < 2) return flows;
  const pairs = pairPublishConsumeSeams(cas);
  if (pairs.length === 0) return flows;

  // A publisher flow's terminus resolves an exit_point_id; a consumer flow is
  // rooted at the consumer entry point (flow.entry_point === ep.id). First flow
  // wins for a given key (stable: flows are already sorted).
  const flowByTerminusExit = new Map<string, FlowConcept>();
  const flowByEntryPoint = new Map<string, FlowConcept>();
  for (const f of flows) {
    if (f.terminus?.exit_point_id && !flowByTerminusExit.has(f.terminus.exit_point_id)) {
      flowByTerminusExit.set(f.terminus.exit_point_id, f);
    }
    if (!flowByEntryPoint.has(f.entry_point)) flowByEntryPoint.set(f.entry_point, f);
  }

  const contByPub = new Map<string, Set<string>>();
  const fromByCon = new Map<string, Set<string>>();
  for (const { exitId, entryId } of pairs) {
    const pub = flowByTerminusExit.get(exitId);
    const con = flowByEntryPoint.get(entryId);
    if (!pub || !con || pub.flow_id === con.flow_id) continue;
    if (!contByPub.has(pub.flow_id)) contByPub.set(pub.flow_id, new Set());
    contByPub.get(pub.flow_id)!.add(con.flow_id);
    if (!fromByCon.has(con.flow_id)) fromByCon.set(con.flow_id, new Set());
    fromByCon.get(con.flow_id)!.add(pub.flow_id);
  }
  if (contByPub.size === 0) return flows;

  for (const f of flows) {
    const cont = contByPub.get(f.flow_id);
    if (cont && cont.size) f.continuations = [...cont].sort();
    const from = fromByCon.get(f.flow_id);
    if (from && from.size) {
      f.continued_from = [...from].sort();
      f.is_subflow = true;
    }
  }
  return flows;
}

/**
 * TERMINAL-CHAIN FLOWS — the primary flow-derivation path. A flow is a logical
 * unit over the compile graph ANCHORED ON A TERMINAL CHAIN: a pre-computed
 * `call_chains` entry of `chain_type === 'entry-to-exit'`, i.e. a chain that
 * runs from an entry point all the way to an EXIT point (an api response, a DB
 * write, an SDK/integration call, a webhook, an emitted event) — what the
 * system actually PRODUCES. Chains that dead-end (produce nothing) are NOT
 * flows; the terminal is the whole point (terminal-signal.ts: "terminal call
 * chains end at what the system produces").
 *
 * Every fact used here is already on the CAS and deterministic: the ordered
 * `call_path` (entry → terminus), the resolved exit point, the same
 * exit_points / data_lineage / data_entities.invariants / entry-point
 * security+validation the entry-point path uses. The chain's own `call_path`
 * IS the chain — we do NOT re-trace a BFS; we segment the exact recorded path
 * into steps. `opts.nameStep` remains the only AI seam and stays inert when
 * omitted; Logic + interpretive meaning are AI-only-or-omitted downstream.
 *
 * Returns [] when there are no entry-to-exit chains, so callers can fall back
 * to entry-point-rooted flows without a regression on repos that don't emit
 * call_chains.
 */
function buildTerminalFlows(cas: CASOutput, opts: ComputeFlowConceptsOptions): FlowConcept[] {
  const chains = (cas.call_chains || []).filter(c => c.chain_type === 'entry-to-exit' && c.exit_point);
  if (chains.length === 0) return [];

  const maxDepth = opts.maxDepth && opts.maxDepth > 0 ? opts.maxDepth : DEFAULT_MAX_DEPTH;
  const maxFunctions = opts.maxFunctionsPerFlow && opts.maxFunctionsPerFlow > 0 ? opts.maxFunctionsPerFlow : DEFAULT_MAX_FUNCTIONS;

  const nodesById = new Map(cas.nodes.map(n => [n.id, n]));
  const capabilities = cas.system_capabilities || [];
  const entryHandlerNodeIdByEpId = buildEntryHandlerNodeIdByEpId(cas);
  const exitPointsByNode = buildExitPointIndex(cas);
  const lineageByNode = buildLineageIndex(cas);
  const conditionalOut = buildConditionalOutIndex(cas);
  const deleterNodeIds = buildDeleterNodeIds(cas);
  const exitById = new Map((cas.exit_points || []).map(e => [e.id, e]));
  const entryById = new Map((cas.entry_points || []).map(e => [e.id, e]));

  const entryPointsByNode = new Map<string, CASEntryPoint[]>();
  for (const ep of cas.entry_points || []) {
    const nodeId = ep.handler?.node_id || ep.source_node;
    if (!entryPointsByNode.has(nodeId)) entryPointsByNode.set(nodeId, []);
    entryPointsByNode.get(nodeId)!.push(ep);
  }

  const allLineage = [...(cas.data_lineage || [])];

  // Entry-family entity rollup (memoized BFS per root): attaches entities the
  // handler's forward-reachable family touches even when this specific chain
  // path missed the accessor node.
  const traversal = buildTraversalIndex(cas);
  const familyEntities = makeEntryFamilyEntities(cas, traversal, maxDepth, maxFunctions);

  // Deterministic order: chains sorted by id so the flow set is byte-stable
  // run-to-run (Camp-B determinism rule). `target` filter matches against the
  // entry method, exit target, and resolved entry-point route/name.
  const sorted = [...chains].sort((a, b) => a.id.localeCompare(b.id));

  const flows: FlowConcept[] = [];

  for (const chain of sorted) {
    // Resolve the ordered chain nodes from the pre-computed call_path (this IS
    // the terminal chain — no re-tracing). Skip unresolvable path nodes rather
    // than fabricating; depth-bound and function-cap still honored so a flow's
    // step count matches the entry-point path's shape.
    const chainNodes: ChainNode[] = [];
    const seen = new Set<string>();
    for (const step of chain.call_path || []) {
      if (step.depth >= maxDepth) continue;
      if (seen.has(step.node_id)) continue;
      const node = nodesById.get(step.node_id);
      if (!node) continue;
      seen.add(step.node_id);
      chainNodes.push({ node, depth: step.depth });
      if (chainNodes.length >= maxFunctions) break;
    }
    if (chainNodes.length === 0) continue;

    const rootEp = chain.entry_point.entry_point_id
      ? entryById.get(chain.entry_point.entry_point_id)
      : undefined;
    const rootNode = nodesById.get(chain.entry_point.node_id);

    // Resolve the terminus: the exit point this chain ends at (what it
    // produces). exit_point_id resolves against cas.exit_points.
    const exit = chain.exit_point?.exit_point_id ? exitById.get(chain.exit_point.exit_point_id) : undefined;
    const terminusNodeId = chain.exit_point?.node_id
      || exit?.source_node
      || chainNodes[chainNodes.length - 1].node.id;

    // `target` narrowing: id / entry method / route / exit target substring.
    if (opts.target) {
      const t = opts.target.toLowerCase();
      const hay = [
        chain.id,
        chain.entry_point.method_name,
        chain.exit_point?.method_name,
        rootEp?.name,
        rootEp?.trigger?.path,
        exit?.target?.service_id,
        exit?.target?.resource,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(t)) continue;
    }

    const segments = segmentIntoSteps(chainNodes, exitPointsByNode, lineageByNode);

    const gaps: string[] = [];
    if (chainNodes.length >= maxFunctions) {
      gaps.push(`Terminal chain truncated at maxFunctionsPerFlow=${maxFunctions}; some downstream steps may be missing.`);
    }
    if ((chain.call_path || []).length > chainNodes.length + 1) {
      gaps.push('Some call_path nodes did not resolve in the graph and were skipped from this flow.');
    }
    if (segments.length === 1) {
      gaps.push('Entire terminal chain classified as a single step — no side-effect or layer boundary detected between entry and terminus.');
    }

    const flowEntryScope = new Set([chain.entry_point.entry_point_id, chain.entry_point.node_id].filter(Boolean) as string[]);
    const steps: FlowStep[] = segments.map((seg, i) => {
      const { name, description } = nameStepDeterministically(seg.character, seg.nodes, exitPointsByNode, allLineage);
      const contract = buildContract(seg.nodes, cas, exitPointsByNode, entryPointsByNode, flowEntryScope);

      let functions: FlowStep['functions'];
      if (seg.nodes.length === 1) {
        const sections = detectSubSections(seg.nodes[0]);
        functions = sections
          ? sections.map(s => ({ function_id: seg.nodes[0].id, section: s }))
          : [{ function_id: seg.nodes[0].id }];
      } else {
        functions = seg.nodes.map(n => ({ function_id: n.id }));
      }

      const stepNodeIds = new Set(seg.nodes.map(n => n.id));
      const step: FlowStep = {
        step_id: `flow::${chain.id}::step${i}`,
        order: i,
        name,
        description,
        description_source: 'deterministic-label',
        contract,
        functions,
        entities: entitiesForNodes(stepNodeIds, cas),
      };
      if (opts.nameStep && rootEp) {
        const override = opts.nameStep(step, { flowEntryPoint: rootEp });
        if (override?.name) step.name = override.name;
        if (override?.description) step.description = override.description;
        if (override?.name || override?.description) step.description_source = 'ai';
      }
      return step;
    });

    // STEP GRAPH: the ordered `steps` are a PROJECTION of a graph — layer
    // branch/error/compensation edges on the sequence backbone (segments align
    // 1:1 with steps by index).
    const stepGraph = buildStepGraph(steps, segments.map(s => s.nodes), conditionalOut, deleterNodeIds);

    const allNodeIds = new Set(chainNodes.map(c => c.node.id));

    // Terminus ICELOT enrichment: the exit the chain ends at IS a produced
    // Output / Effect. Fold it into the flow-level contract deterministically
    // (evidence = the resolved exit point) so the flow's Output/Effects reflect
    // what it actually produces at the terminus, not just node return types.
    const contract = aggregateFlowContract(steps);
    let terminus: FlowConcept['terminus'];
    if (exit) {
      const produces = exit.target?.service_id || exit.target?.resource || exit.target?.endpoint
        || exit.name || exit.type;
      terminus = { exit_point_id: exit.id, kind: exit.type, produces, node_id: terminusNodeId };
      const label = `${exit.type}:${produces}`;
      if (exit.type === 'database' || exit.type === 'cache' || exit.type === 'file') {
        if (!contract.side_effects.state_changes.includes(label)) contract.side_effects.state_changes.push(label);
      } else {
        if (!contract.side_effects.external_integrations.includes(label)) contract.side_effects.external_integrations.push(label);
        // api / webhook / event terminals are the flow's response/emission —
        // record what it emits in Output too (deterministic, evidence-gated on
        // the resolved exit point).
        if (['api', 'webhook', 'event', 'navigation'].includes(exit.type)) {
          const out = exit.data?.output_type || `${exit.type} ${produces}`;
          if (!contract.output.includes(out)) contract.output.push(out);
        }
      }
    }

    // M:N capability relationships (role on the EDGE — doctrine: flow roles
    // are relational, not intrinsic). capability_id stays populated as the
    // primary relationship's capability for back-compat.
    const flowEntities = unionEntities(entitiesForNodes(allNodeIds, cas), familyEntities(chain.entry_point.node_id));
    const capabilityRelationships = deriveCapabilityRelationships({
      capabilities,
      entryPointId: rootEp?.id || chain.entry_point.entry_point_id,
      rootNodeId: rootEp ? (rootEp.handler?.node_id || rootEp.source_node) : chain.entry_point.node_id,
      entities: flowEntities,
      telemetry: telemetryExitDominance(allNodeIds, exitPointsByNode, terminus?.kind),
      pathNodeIds: allNodeIds,
      entryHandlerNodeIdByEpId,
    });
    const capabilityId = capabilityRelationships.find(r => r.role === 'primary')?.capability_id;
    if (capabilityRelationships.length === 0) {
      gaps.push('No system_capabilities entry references this flow\'s entry point or shares its touched entities — capability_relationships omitted rather than guessed.');
    } else if (!capabilityId) {
      gaps.push('No system_capabilities operation references this flow\'s entry point — capability_id (primary) omitted rather than guessed; only non-primary relationships derived.');
    }

    const flowName = rootEp
      ? flowNameForEntryPoint(rootEp)
      : titleize(chain.entry_point.method_name);
    const produced = terminus ? ` → ${terminus.kind} ${terminus.produces}` : '';
    const intent = rootEp
      ? `${flowIntentForEntryPoint(rootEp)}${produced}`
      : `Chain from ${chain.entry_point.method_name}${produced}`;

    flows.push({
      flow_id: `flow::${chain.id}`,
      name: flowName,
      intent,
      entry_point: chain.entry_point.entry_point_id || chain.entry_point.node_id,
      capability_id: capabilityId,
      capability_relationships: capabilityRelationships.length ? capabilityRelationships : undefined,
      entities: flowEntities,
      contract,
      steps,
      terminus,
      step_graph: stepGraph,
      gaps: gaps.length ? gaps : undefined,
    });
    void rootNode; // rootNode resolution kept for symmetry / future naming; not required.

    if (opts.maxFlows && opts.maxFlows > 0 && flows.length >= opts.maxFlows) break;
  }

  return flows;
}

/** Title-case a raw method/handler name for a flow display name when there is
 *  no resolved entry point to name from. */
function titleize(raw: string): string {
  const words = (raw || '').replace(/[-_]/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return words.split(' ').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || raw;
}

/**
 * computeFlowConcepts — flows over the compile graph. UNION of two anchors:
 * terminal call chains (buildTerminalFlows) — a flow is a chain that runs from
 * an entry point to an EXIT point (what the system produces) — PLUS
 * entry-point-rooted flows for significant entry points whose chains dead-end
 * (event handlers, routes, MCP tools, scheduled jobs legitimately lacking a
 * clean exit). Deduped by entry point (terminal wins). When the CAS carries no
 * entry-to-exit chains at all, every flow is entry-point-rooted (the original
 * behavior), so repos without call_chains still get flows.
 *
 * Deterministic-first either way: composes entry_points, call
 * edges/method_calls, exit_points, data_lineage, data_entities.invariants,
 * entry_point security/validation, and system_capabilities already on the CAS.
 * `opts.nameStep` is the only AI seam and is fully inert when omitted.
 */
export function computeFlowConcepts(cas: CASOutput, opts: ComputeFlowConceptsOptions = {}): FlowConcept[] {
  // PRIMARY: terminal-chain-anchored flows (what the system produces).
  const terminalFlows = buildTerminalFlows(cas, opts);

  // UNION (not all-or-nothing): a handful of terminal chains must not suppress
  // every entry-point flow — entry points whose chains dead-end (event
  // handlers, HTTP routes, MCP tools, scheduled jobs legitimately lacking a
  // clean exit) still deserve flows. Dedup by entry point: an entry point
  // already covered by a terminal-anchored flow contributes no second flow
  // (terminal wins — it carries the terminus). Entry-point flows in the union
  // are significance-filtered (non-test, non-trivial) so the count stays sane.
  let flows: FlowConcept[];
  if (terminalFlows.length === 0) {
    flows = computeEntryPointFlows(cas, opts);
  } else if (opts.maxFlows && opts.maxFlows > 0 && terminalFlows.length >= opts.maxFlows) {
    flows = terminalFlows;
  } else {
    // Covered keys: the terminal flow's entry_point is entry_point_id when the
    // chain resolved one, else the raw root node id — exclude BOTH forms so an
    // entry-point-rooted flow for the same root never duplicates it.
    const coveredEntryKeys = new Set<string>();
    const entryById = new Map((cas.entry_points || []).map(e => [e.id, e]));
    for (const flow of terminalFlows) {
      coveredEntryKeys.add(flow.entry_point);
      const ep = entryById.get(flow.entry_point);
      if (ep) coveredEntryKeys.add(ep.handler?.node_id || ep.source_node);
    }

    const remaining = opts.maxFlows && opts.maxFlows > 0 ? opts.maxFlows - terminalFlows.length : undefined;
    const entryFlows = computeEntryPointFlows(
      cas,
      { ...opts, maxFlows: remaining },
      { excludeEntryKeys: coveredEntryKeys, significantOnly: true }
    );
    flows = [...terminalFlows, ...entryFlows];
  }

  // ASYNC CONTINUATION STITCHING (C1): a publisher flow whose terminus is an
  // event/message publish CONTINUES INTO the consumer flow whose entry matches
  // the seam channel — the SAME end-to-end flow, and the consumer is a reusable
  // subflow. Runs over the full union (publisher may be terminal, consumer
  // entry-point-rooted). Evidence-gated + deterministic; no-op when no pair.
  return stitchContinuations(flows, cas);
}

/**
 * Entry-point-rooted flows — one FlowConcept per (matching) entry point,
 * forward-traced. The ONLY derivation path when the CAS carries no
 * entry-to-exit call chains; the UNION complement (dead-end entries) when it
 * does. Same deterministic fact sources as the terminal path.
 *
 * `unionOpts` (internal, set only by computeFlowConcepts' union path):
 *   - excludeEntryKeys: entry-point ids / root node ids already covered by a
 *     terminal-anchored flow (dedup — terminal wins).
 *   - significantOnly: drop test entries and trivial dead flows (a single
 *     traced node with no exits, no lineage, and no security/validation
 *     surface) so 3,700 raw entry points don't become 3,700 noise flows.
 */
function computeEntryPointFlows(
  cas: CASOutput,
  opts: ComputeFlowConceptsOptions = {},
  unionOpts: { excludeEntryKeys?: Set<string>; significantOnly?: boolean } = {}
): FlowConcept[] {
  const maxDepth = opts.maxDepth && opts.maxDepth > 0 ? opts.maxDepth : DEFAULT_MAX_DEPTH;
  const maxFunctions = opts.maxFunctionsPerFlow && opts.maxFunctionsPerFlow > 0 ? opts.maxFunctionsPerFlow : DEFAULT_MAX_FUNCTIONS;

  const nodesById = new Map(cas.nodes.map(n => [n.id, n]));
  const capabilities = cas.system_capabilities || [];
  const entryHandlerNodeIdByEpId = buildEntryHandlerNodeIdByEpId(cas);

  const realEntryPoints = cas.entry_points || [];
  const realRootNodeIds = new Set(realEntryPoints.map(ep => ep.handler?.node_id || ep.source_node));
  const synthesizedRoots = deriveCapabilityOperationRoots(cas, capabilities, nodesById, realRootNodeIds);
  const synthesizedRootIds = new Set(synthesizedRoots.map(r => r.ep.id));

  let entryPoints: CASEntryPoint[] = [...realEntryPoints, ...synthesizedRoots.map(r => r.ep)];
  if (unionOpts.excludeEntryKeys && unionOpts.excludeEntryKeys.size > 0) {
    const covered = unionOpts.excludeEntryKeys;
    entryPoints = entryPoints.filter(ep =>
      !covered.has(ep.id) && !covered.has(ep.handler?.node_id || ep.source_node)
    );
  }
  if (unionOpts.significantOnly) {
    // Test entries never make product flows (the union must stay sane).
    entryPoints = entryPoints.filter(ep => ep.type !== 'test');
  }
  if (opts.target) {
    const t = opts.target.toLowerCase();
    entryPoints = entryPoints.filter(ep =>
      ep.id.toLowerCase() === t ||
      ep.name.toLowerCase().includes(t) ||
      (ep.trigger?.path || '').toLowerCase().includes(t) ||
      ep.source_node.toLowerCase() === t
    );
  }
  const maxEntryFlows = opts.maxFlows && opts.maxFlows > 0 ? opts.maxFlows : undefined;

  const exitPointsByNode = buildExitPointIndex(cas);
  const lineageByNode = buildLineageIndex(cas);
  const conditionalOut = buildConditionalOutIndex(cas);
  const deleterNodeIds = buildDeleterNodeIds(cas);

  const entryPointsByNode = new Map<string, CASEntryPoint[]>();
  for (const ep of cas.entry_points || []) {
    const nodeId = ep.handler?.node_id || ep.source_node;
    if (!entryPointsByNode.has(nodeId)) entryPointsByNode.set(nodeId, []);
    entryPointsByNode.get(nodeId)!.push(ep);
  }

  const allLineage = [...(cas.data_lineage || [])];

  // terminal-signal is used ONLY as an optional naming aid downstream (via
  // dominantEntityForNodes -> data_lineage, not terminal-signal directly);
  // kept here so a future naming refinement can rank steps against it
  // without another CAS-wide pass. Computed once, lazily unused otherwise.
  void buildTerminalSignal; // referenced for future step-naming refinement; not required for correctness today.

  const traversal = buildTraversalIndex(cas);

  const flows: FlowConcept[] = [];

  for (const ep of entryPoints) {
    if (maxEntryFlows !== undefined && flows.length >= maxEntryFlows) break;
    const rootNode = nodesById.get(ep.handler?.node_id || ep.source_node);
    if (!rootNode) continue;

    const chain = traceForwardChain(traversal, rootNode.id, maxDepth, maxFunctions);
    if (chain.length === 0) continue;

    if (unionOpts.significantOnly && chain.length === 1) {
      // A single traced node with NO observable surface — no exits, no entity
      // lineage, no auth/validation on the entry — is a trivial dead flow;
      // skip it in the union so the flow count stays product-shaped. All
      // checks are existing CAS facts (evidence, not name heuristics).
      const rootId = rootNode.id;
      const hasExit = (exitPointsByNode.get(rootId) || []).length > 0;
      const hasLineage = Boolean(lineageByNode.get(rootId));
      const hasSurface = Boolean(
        ep.security?.authenticated ||
        (ep.security?.guards || []).length > 0 ||
        (ep.input?.validation || []).length > 0
      );
      if (!hasExit && !hasLineage && !hasSurface) continue;
    }

    const segments = segmentIntoSteps(chain, exitPointsByNode, lineageByNode);

    const gaps: string[] = [];
    if (synthesizedRootIds.has(ep.id)) {
      gaps.push('Root synthesized from a system_capabilities operation node reference — this codebase\'s entry-point extraction did not surface a dedicated entry point for this handler.');
    }
    if (chain.length >= maxFunctions) {
      gaps.push(`Call chain truncated at maxFunctionsPerFlow=${maxFunctions}; some downstream steps may be missing.`);
    }
    if (segments.length === 1) {
      gaps.push('Entire chain classified as a single step — no side-effect or layer boundary detected; segmentation is coarse for this flow.');
    }

    const flowEntryScope = new Set([ep.id, ep.handler?.node_id || ep.source_node].filter(Boolean) as string[]);
    const steps: FlowStep[] = segments.map((seg, i) => {
      const { name, description } = nameStepDeterministically(seg.character, seg.nodes, exitPointsByNode, allLineage);
      const contract = buildContract(seg.nodes, cas, exitPointsByNode, entryPointsByNode, flowEntryScope);

      // sub-section detection: only meaningful when the step maps to a
      // SINGLE function (a multi-function step is already segmented at
      // function granularity — sub-sectioning is for splitting the inside
      // of one large function).
      let functions: FlowStep['functions'];
      if (seg.nodes.length === 1) {
        const sections = detectSubSections(seg.nodes[0]);
        functions = sections
          ? sections.map(s => ({ function_id: seg.nodes[0].id, section: s }))
          : [{ function_id: seg.nodes[0].id }];
      } else {
        functions = seg.nodes.map(n => ({ function_id: n.id }));
      }

      const stepNodeIds = new Set(seg.nodes.map(n => n.id));
      const step: FlowStep = {
        step_id: `${ep.id}::step${i}`,
        order: i,
        name,
        description,
        description_source: 'deterministic-label',
        contract,
        functions,
        entities: entitiesForNodes(stepNodeIds, cas),
      };
      if (opts.nameStep) {
        const override = opts.nameStep(step, { flowEntryPoint: ep });
        if (override?.name) step.name = override.name;
        if (override?.description) step.description = override.description;
        if (override?.name || override?.description) step.description_source = 'ai';
      }
      return step;
    });

    // STEP GRAPH: ordered `steps` are a PROJECTION — layer branch/error/
    // compensation edges on the sequence backbone (segments align 1:1 by index).
    const stepGraph = buildStepGraph(steps, segments.map(s => s.nodes), conditionalOut, deleterNodeIds);

    const allNodeIds = new Set(chain.map(c => c.node.id));
    // M:N capability relationships (role on the EDGE); capability_id stays the
    // primary relationship's capability for back-compat.
    const flowEntities = entitiesForNodes(allNodeIds, cas);
    const capabilityRelationships = deriveCapabilityRelationships({
      capabilities,
      entryPointId: ep.id,
      rootNodeId: ep.handler?.node_id || ep.source_node,
      entities: flowEntities,
      // No resolved terminus on entry-point-rooted flows — dominance derives
      // from the traced nodes' own exit points alone.
      telemetry: telemetryExitDominance(allNodeIds, exitPointsByNode),
      pathNodeIds: allNodeIds,
      entryHandlerNodeIdByEpId,
    });
    const capabilityId = capabilityRelationships.find(r => r.role === 'primary')?.capability_id;
    if (capabilityRelationships.length === 0) {
      gaps.push('No system_capabilities entry references this entry point or shares its touched entities — capability_relationships omitted rather than guessed.');
    } else if (!capabilityId) {
      gaps.push('No system_capabilities operation references this entry point — capability_id (primary) omitted rather than guessed; only non-primary relationships derived.');
    }

    flows.push({
      flow_id: `flow::${ep.id}`,
      name: flowNameForEntryPoint(ep),
      intent: flowIntentForEntryPoint(ep),
      entry_point: ep.id,
      // No separate entry-family union here: this chain IS the root's forward
      // family (same traversal, same bounds), unlike the terminal path where
      // the recorded call_path is one narrow route through it.
      capability_id: capabilityId,
      capability_relationships: capabilityRelationships.length ? capabilityRelationships : undefined,
      entities: flowEntities,
      contract: aggregateFlowContract(steps),
      steps,
      step_graph: stepGraph,
      gaps: gaps.length ? gaps : undefined,
    });
  }

  return flows;
}

// ---------------------------------------------------------------------------
// TELEMETRY FACET (facet 6) — evidence-gated runtime join
// ---------------------------------------------------------------------------

/**
 * Minimal per-unit runtime metric shape the telemetry join consumes. It is a
 * structural subset of the MCP server's `NodeRuntimeMetrics`
 * (product.buildNodeRuntimeMetrics) — declared here so analyzer-core carries
 * no dependency on the app layer; the query layer maps NodeRuntimeMetrics onto
 * this. Every field that reaches a unit came from a real observation.
 */
export interface RuntimeMetricLike {
  static_id: string;
  node_id?: string;
  entry_point_id?: string;
  route?: string;
  method?: string;
  request_count: number;
  error_rate: number;
  latency?: { p50_ms?: number | null; p95_ms?: number | null; p99_ms?: number | null };
  status_code_distribution?: Record<string, number>;
  source?: string;
  last_seen?: string;
}

/** Build a lookup from every id/route a metric can be keyed by -> the metric,
 *  so a unit can be matched by node id, entry-point id, or "METHOD /route". */
function indexRuntimeMetrics(metrics: RuntimeMetricLike[]): Map<string, RuntimeMetricLike> {
  const index = new Map<string, RuntimeMetricLike>();
  for (const m of metrics) {
    const keys = [
      m.static_id,
      m.node_id,
      m.entry_point_id,
      m.route,
      m.method && m.route ? `${m.method.toUpperCase()} ${m.route}` : undefined,
    ].filter((k): k is string => Boolean(k));
    for (const k of keys) if (!index.has(k)) index.set(k, m);
  }
  return index;
}

function toContractTelemetry(m: RuntimeMetricLike): ContractTelemetry {
  const t: ContractTelemetry = {
    static_id: m.static_id,
    request_count: m.request_count,
    error_rate: m.error_rate,
    source: m.source || 'ingested',
  };
  if (m.latency?.p50_ms != null) t.p50_ms = m.latency.p50_ms;
  if (m.latency?.p95_ms != null) t.p95_ms = m.latency.p95_ms;
  if (m.latency?.p99_ms != null) t.p99_ms = m.latency.p99_ms;
  if (m.status_code_distribution && Object.keys(m.status_code_distribution).length > 0) {
    t.status_code_distribution = m.status_code_distribution;
  }
  if (m.last_seen) t.last_seen = m.last_seen;
  return t;
}

/** Find the telemetry for a unit given the node ids it owns plus an optional
 *  entry-point id (flow root) / route key. Returns undefined when NO real
 *  runtime data matches — the facet is then omitted, never fabricated. */
function telemetryForUnit(
  index: Map<string, RuntimeMetricLike>,
  nodeIds: Iterable<string>,
  extraKeys: Array<string | undefined> = []
): ContractTelemetry | undefined {
  for (const key of extraKeys) {
    if (key && index.has(key)) return toContractTelemetry(index.get(key)!);
  }
  for (const id of nodeIds) {
    if (index.has(id)) return toContractTelemetry(index.get(id)!);
  }
  return undefined;
}

/**
 * Join runtime telemetry (facet 6) onto already-computed flows: attaches
 * `contract.telemetry` to a flow (keyed on its entry point / root node) and to
 * each step (keyed on the step's own function ids). Purely additive — mutates
 * in place and returns the same array. When `metrics` is empty, or nothing
 * matches, every telemetry field is simply left absent (evidence-gated: no
 * observation -> no facet). This runs at the query layer, where persisted
 * observations are available, NOT inside computeFlowConcepts (which stays a
 * pure static pass over the CAS).
 */
export function attachTelemetryToFlows(flows: FlowConcept[], metrics: RuntimeMetricLike[]): FlowConcept[] {
  if (!metrics || metrics.length === 0) return flows;
  const index = indexRuntimeMetrics(metrics);
  if (index.size === 0) return flows;

  for (const flow of flows) {
    const flowNodeIds = new Set<string>();
    for (const step of flow.steps) {
      const stepNodeIds = step.functions.map(f => f.function_id);
      for (const id of stepNodeIds) flowNodeIds.add(id);
      const stepTel = telemetryForUnit(index, stepNodeIds);
      if (stepTel) step.contract.telemetry = stepTel;
    }
    const flowTel = telemetryForUnit(index, flowNodeIds, [flow.entry_point]);
    if (flowTel) flow.contract.telemetry = flowTel;
  }
  return flows;
}

/** Standalone telemetry lookup for a single node (used by get_coding_context,
 *  which resolves one target node rather than a whole flow). Undefined when no
 *  observation matches. */
export function telemetryForNode(nodeId: string, metrics: RuntimeMetricLike[]): ContractTelemetry | undefined {
  if (!metrics || metrics.length === 0) return undefined;
  const index = indexRuntimeMetrics(metrics);
  return telemetryForUnit(index, [nodeId]);
}
