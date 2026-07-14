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

/** AI-REFRAME PLUG POINT (D2, docs/SEMANTIC-MODEL.md ICELOT): the interpretive
 *  Logic summary of a unit — "Logic and interpretive reframing are AI-only,
 *  evidence-gated, with provenance". This field is AI-ONLY-OR-ABSENT
 *  (docs/cas/DETERMINISM-BOUNDARY.md): the deterministic pass NEVER populates
 *  it under any circumstances; only the query-layer AI enrichment pass may set
 *  it, and every claim in `text` must be backed by the `evidence_refs` it
 *  cites (facet values / node ids / constraint rules already on the contract). */
export interface LogicSummary {
  text: string;
  description_source: 'ai';
  /** Refs into the deterministic evidence the summary reframes — facet entry
   *  values, node/step ids, or constraint rules. Never empty: an AI summary
   *  with nothing to cite must be rejected, not stored. */
  evidence_refs: string[];
}

/** Which facet a provenance record annotates. */
export type ProvenanceFacet =
  | 'input'
  | 'output'
  | 'state_change'
  | 'external_integration'
  | 'constraint'
  | 'telemetry';

/**
 * FACET PROVENANCE (D2, docs/SEMANTIC-MODEL.md "Evidence and confidence —
 * everywhere"): where a facet ENTRY came from, so the chain flow facet → step
 * → code fact is walkable. At the STEP level `contributed_by_step_ids` is
 * absent (the step itself is the contributor) and `evidence` is the concrete
 * code-level fact (signature / exit point / data_lineage membership) that
 * produced the entry. At the FLOW level `contributed_by_step_ids` names the
 * step(s) whose contracts contributed the entry, and `evidence` is LIFTED from
 * the contributing step's own facet evidence — never re-derived, never
 * fabricated. `source` is always 'deterministic' here: an AI pass that wants
 * to reframe a facet plugs in via `logic_summary` / `description_source`, not
 * by writing provenance records.
 */
export interface FacetProvenance {
  facet: ProvenanceFacet;
  /** The exact facet entry this annotates (the input/output/effect string, or
   *  the constraint's `rule`). */
  value: string;
  /** FLOW level only: step_id(s) whose contract contributed this entry, sorted. */
  contributed_by_step_ids?: string[];
  source: 'deterministic';
  /** The concrete fact that produced the entry. */
  evidence: string;
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
  /** Per-entry provenance for input/output/effect facet entries (constraints
   *  carry their evidence inline and additionally surface here at the FLOW
   *  level so the step attribution is walkable). Sorted (facet, value);
   *  omitted when no entries carry evidence. Additive — serialization spreads. */
  facet_provenance?: FacetProvenance[];
  /** AI-reframe plug point — see LogicSummary. ABSENT in deterministic runs. */
  logic_summary?: LogicSummary;
}

/**
 * FLOW-level contract (D2 aggregation/reframe rules): the flow's ICELOT is a
 * REFRAME of its steps' facets, never a simple union (docs/SEMANTIC-MODEL.md):
 *   Input  = the flow's INITIATING input only (the entry step's contract —
 *            entry-point signature params + entry-step reads); interior step
 *            inputs are DEMOTED to `internal_inputs_count`, not unioned.
 *   Output = the flow's TERMINAL output (last step's output, plus the resolved
 *            terminus emission folded in by the terminal path); intermediate
 *            returns are demoted to `internal_outputs_count`.
 *   Effects = union deduped by target, each stamped with the contributing
 *            step(s) via `facet_provenance`.
 *   Constraints = entry-scoped error constraints + step constraints that GATE
 *            the whole flow (a guard on a non-terminal step gates everything
 *            after it; a guard on the last step gates nothing downstream and
 *            stays step-level only).
 *   Telemetry = joined end-to-end at the query layer (unchanged), stamped
 *            with provenance when attached.
 */
export interface FlowILSOContract extends ILSOContract {
  /** Distinct interior-step input entries demoted from flow-level Input
   *  (present only when > 0 — never zero-filled). They remain fully visible
   *  on their own steps' contracts. */
  internal_inputs_count?: number;
  /** Distinct non-terminal-step output entries demoted from flow-level Output
   *  (present only when > 0). */
  internal_outputs_count?: number;
}

/**
 * D1 (docs/SEMANTIC-MODEL.md, Step): "Step ↔ code is many-to-many. One step may
 * span several functions plus a branch inside another; one large function may
 * contain several steps; a generic authorizeRequest() may serve hundreds of
 * steps." The mapping is TYPED — how a code region relates to the step, not
 * just that it does.
 *
 * Deterministic (Camp-B) derivation rules — every relationship is grounded in a
 * fact the CAS already computed, never fabricated:
 *   - 'implements'            — default for the SOLE node of a step's segment
 *                               when no more-specific relationship applies.
 *   - 'partially_implements'  — default for each node of a MULTI-node segment
 *                               when no more-specific relationship applies.
 *   - 'initiates'             — the node bound to the flow's entry point
 *                               (first step only).
 *   - 'completes'             — the node resolving the flow's terminus exit
 *                               point (terminal step of a terminal-chain flow).
 *   - 'validates'             — the node contributes a non-error constraint
 *                               (source guard clause, entry-point auth/
 *                               validation facts, data-entity invariant
 *                               enforced_by — the same facts D2's provenance
 *                               cites).
 *   - 'handles_failure'       — the node is an instance of a try-catch pattern
 *                               (cas.patterns) — it sits on a catch path.
 *   - 'branches'              — the node has a conditional control-flow
 *                               successor (buildConditionalOutIndex evidence,
 *                               the same facts C1's 'branch' step-graph edges
 *                               use).
 *   - 'causes_effect'         — the node contributes a state change or
 *                               external integration (its own exit points /
 *                               data_lineage writes — D2's effects facts).
 *   - 'observes'              — the node contributes TELEMETRY ONLY (all its
 *                               exits are telemetry kinds, no writes).
 *   - 'provides_input'        — the node writes an entity the NEXT step's
 *                               nodes read (data_lineage only; skipped when
 *                               not derivable — no fabrication).
 *   - 'consumes_output'       — the node reads an entity the PREVIOUS step's
 *                               nodes wrote (data_lineage only).
 *   - 'transforms'            — in the vocabulary (doctrine) but carries NO
 *                               deterministic derivation rule yet; only an
 *                               AI/manual pass may assert it, evidence-gated
 *                               (same posture as the prerequisite/recovery
 *                               capability-flow roles).
 *
 * A node can carry MULTIPLE mappings within one step (e.g. a controller node
 * that initiates + validates + causes_effect), and the SAME node mapped into
 * different steps (shared helpers across flows) can carry different
 * relationships in each — that is the many-to-many point.
 */
export type StepCodeRelationship =
  | 'implements'
  | 'partially_implements'
  | 'initiates'
  | 'completes'
  | 'validates'
  | 'branches'
  | 'transforms'
  | 'causes_effect'
  | 'observes'
  | 'handles_failure'
  | 'provides_input'
  | 'consumes_output';

/** The code region a mapping points at. Node-level today; `line_range` is
 *  present only when the node carries real span facts (source.line/end_line) —
 *  never invented. */
export interface StepCodeRegion {
  node_id: string;
  file?: string;
  line_range?: [number, number];
}

/** INTRA-FUNCTION SEGMENTATION PLUG POINT (D1, docs/SEMANTIC-MODEL.md:
 *  "intra-function step segmentation (AI-proposed, evidence-gated)"): a
 *  sub-region INSIDE the mapped node that realizes just this step. AI-ONLY-
 *  OR-ABSENT per docs/cas/DETERMINISM-BOUNDARY.md — the deterministic pass
 *  NEVER populates it; only a future AI enrichment pass may, and every
 *  proposed segment must cite the deterministic evidence (`evidence_refs`)
 *  that grounds it. */
export interface StepCodeSubSegment {
  label: string;
  line_range: [number, number];
  description_source: 'ai';
  evidence_refs: string[];
}

export interface StepCodeMapping {
  step_id: string;
  code_region: StepCodeRegion;
  relationship: StepCodeRelationship;
  /** Short deterministic phrase citing the concrete fact that produced this
   *  mapping (same style as D2's facet-provenance evidence strings). */
  contribution: string;
  /** 1.0 for mappings derived from direct CAS facts (all deterministic rules
   *  above are). Weaker derivations should be omitted, not down-weighted. */
  confidence: number;
  /** ABSENT in deterministic runs — see StepCodeSubSegment. */
  sub_segments?: StepCodeSubSegment[];
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
  /** D1 typed step↔code mappings (many-to-many; see StepCodeMapping). One or
   *  more mappings per node in this step's segment, each grounded in a CAS
   *  fact. Sorted (node_id, relationship), capped at STEP_CODE_MAPPING_CAP.
   *  Additive — consumers reading `functions`/`contract` see no change. */
  code_mappings?: StepCodeMapping[];
  /** Honest truncation marker: how many derived mappings were dropped by the
   *  STEP_CODE_MAPPING_CAP. Present only when > 0 — never zero-filled. */
  code_mappings_truncated?: number;
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
  /** Flow-level I/L/S/O + Constraints — a REFRAME of the steps' facets, not a
   *  union (FlowILSOContract: initiating input, terminal output, deduped
   *  effects with step provenance, flow-gating constraints). */
  contract: FlowILSOContract;
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

  // STEP-LEVEL facet provenance (D2): every input/output/effect entry carries
  // the concrete code fact that produced it (first fact wins for a deduped
  // entry — stable, since node iteration order is the segment order). The
  // evidence is a fact ALREADY AT HAND at extraction time, never re-derived.
  const provenanceByKey = new Map<string, FacetProvenance>();
  const recordEvidence = (facet: ProvenanceFacet, value: string, evidence: string) => {
    const key = `${facet}\u0000${value}`;
    if (provenanceByKey.has(key)) return;
    provenanceByKey.set(key, { facet, value, source: 'deterministic', evidence });
  };

  const nodeIds = new Set(nodes.map(n => n.id));

  for (const node of nodes) {
    for (const p of node.signature?.parameters || []) {
      const v = p.type ? `${p.name}: ${p.type}` : p.name;
      input.add(v);
      recordEvidence('input', v, `node "${node.name}" signature.parameters`);
    }
    if (node.signature?.return_type) {
      output.add(node.signature.return_type);
      recordEvidence('output', node.signature.return_type, `node "${node.name}" signature.return_type`);
    }

    for (const ep of exitPointsByNode.get(node.id) || []) {
      const label = ep.target?.service_id || ep.target?.resource || `${ep.type}:${ep.name}`;
      if (ep.type === 'database' || ep.type === 'cache' || ep.type === 'file') {
        stateChanges.add(label);
        recordEvidence('state_change', label, `exit point ${ep.id} (${ep.type}) on node "${node.name}"`);
      } else {
        externalIntegrations.add(label);
        recordEvidence('external_integration', label, `exit point ${ep.id} (${ep.type}) on node "${node.name}"`);
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
    if (writesHere) {
      stateChanges.add(`${entry.entity_name} updated`);
      recordEvidence('state_change', `${entry.entity_name} updated`,
        `data_lineage "${entry.entity_name}" writers include a node in this unit`);
    }
    if (readsHere) {
      input.add(`reads ${entry.entity_name}`);
      recordEvidence('input', `reads ${entry.entity_name}`,
        `data_lineage "${entry.entity_name}" readers include a node in this unit`);
    }
    if (writesHere || readsHere) {
      for (const rec of entry.external_recipients) {
        externalIntegrations.add(rec.service);
        recordEvidence('external_integration', rec.service,
          `data_lineage "${entry.entity_name}" external_recipients names ${rec.service}`);
      }
    }
  }

  const ownEntryPoints = nodes.flatMap(n => entryPointsByNode.get(n.id) || []);
  for (const c of extractStructuralConstraints(nodeIds, cas, ownEntryPoints, exitPointsByNode, scopeEntryPointIds)) addConstraint(c);

  const logicNames = nodes.map(n => n.name);
  const facetProvenance = sortFacetProvenance([...provenanceByKey.values()]);
  return {
    input: [...input],
    logic: logicNames.length > 1 ? logicNames.join(' -> ') : (logicNames[0] || ''),
    side_effects: {
      state_changes: [...stateChanges],
      external_integrations: [...externalIntegrations],
    },
    output: [...output],
    constraints,
    ...(facetProvenance.length > 0 ? { facet_provenance: facetProvenance } : {}),
  };
}

/** Defensive bound on provenance records per contract — facet arrays are
 *  already capped by maxFunctionsPerFlow, so this only guards pathology. */
const FACET_PROVENANCE_CAP = 200;

/** Deterministic order for provenance records: (facet, value) — byte-stable
 *  run-to-run regardless of extraction order. Capped sanely. */
function sortFacetProvenance(entries: FacetProvenance[]): FacetProvenance[] {
  const sorted = [...entries].sort((a, b) =>
    a.facet.localeCompare(b.facet) || a.value.localeCompare(b.value));
  return sorted.length > FACET_PROVENANCE_CAP ? sorted.slice(0, FACET_PROVENANCE_CAP) : sorted;
}

/** Evidence a step's own contract recorded for a facet entry, when present —
 *  the LIFT source for flow-level provenance (flow facet → step → code fact). */
function stepFacetEvidence(step: FlowStep, facet: ProvenanceFacet, value: string): string | undefined {
  return step.contract.facet_provenance?.find(p => p.facet === facet && p.value === value)?.evidence;
}

/**
 * Aggregate step contracts up to the flow-level contract — the D2 REFRAME
 * rules (docs/SEMANTIC-MODEL.md ICELOT: "a flow's ICELOT aggregates its steps
 * and adds flow-level semantics … never a simple union"):
 *
 *   (a) Input  = the INITIATING step's input only (the entry-point handler
 *       segment — its signature params + its own reads). Interior step inputs
 *       are demoted to `internal_inputs_count`, never unioned up.
 *   (b) Output = the TERMINAL step's output only (what survives to the end of
 *       the chain; the terminal path additionally folds the resolved terminus
 *       emission in afterwards). Intermediate returns are demoted to
 *       `internal_outputs_count`.
 *   (c) Effects = union deduped by target (they OUTLIVE the flow regardless of
 *       which step caused them), each stamped in `facet_provenance` with the
 *       contributing step id(s) and the step's own code-fact evidence.
 *   (d) Constraints = only constraints that GATE the flow: 'error' constraints
 *       (already entry-scoped to this flow's chains) always stay; any other
 *       constraint is promoted only when a NON-TERMINAL step enforces it (a
 *       guard on step 1 gates everything after it — a guard on the last step
 *       gates nothing downstream and stays step-level). A single-step flow's
 *       constraints gate the whole flow trivially.
 *   (e) Telemetry is joined end-to-end at the query layer (attachTelemetryToFlows).
 *
 * Every flow-level facet entry gets a `facet_provenance` record —
 * {facet, value, contributed_by_step_ids (sorted), source:'deterministic',
 * evidence lifted from the step} — so the chain flow → step → code is
 * walkable. Deterministic: provenance sorted (facet, value), step ids sorted,
 * capped at FACET_PROVENANCE_CAP.
 */
function aggregateFlowContract(steps: FlowStep[]): FlowILSOContract {
  const provenanceByKey = new Map<string, FacetProvenance & { contributed_by_step_ids: string[] }>();
  const record = (facet: ProvenanceFacet, value: string, stepId: string, evidence: string) => {
    const key = `${facet}\u0000${value}`;
    const existing = provenanceByKey.get(key);
    if (existing) {
      if (!existing.contributed_by_step_ids.includes(stepId)) existing.contributed_by_step_ids.push(stepId);
      return;
    }
    provenanceByKey.set(key, { facet, value, contributed_by_step_ids: [stepId], source: 'deterministic', evidence });
  };

  const lastIdx = steps.length - 1;
  const initiating = steps[0];
  const terminal = steps[lastIdx];

  // (a) Input = initiating input only; interior inputs demoted to a count.
  const input = [...initiating.contract.input];
  const inputSet = new Set(input);
  for (const v of input) {
    record('input', v, initiating.step_id,
      stepFacetEvidence(initiating, 'input', v) ?? `initiating step "${initiating.name}" contract input`);
  }
  const interiorInputs = new Set<string>();
  for (const step of steps.slice(1)) {
    for (const v of step.contract.input) if (!inputSet.has(v)) interiorInputs.add(v);
  }

  // (b) Output = terminal output only; intermediate returns demoted to a count.
  const output = [...terminal.contract.output];
  const outputSet = new Set(output);
  for (const v of output) {
    record('output', v, terminal.step_id,
      stepFacetEvidence(terminal, 'output', v) ?? `terminal step "${terminal.name}" contract output`);
  }
  const interiorOutputs = new Set<string>();
  for (const step of steps.slice(0, lastIdx)) {
    for (const v of step.contract.output) if (!outputSet.has(v)) interiorOutputs.add(v);
  }

  // (c) Effects = union deduped by target, stamped with contributing step(s).
  const stateChanges = new Set<string>();
  const externalIntegrations = new Set<string>();
  for (const step of steps) {
    for (const v of step.contract.side_effects.state_changes) {
      stateChanges.add(v);
      record('state_change', v, step.step_id,
        stepFacetEvidence(step, 'state_change', v) ?? `step "${step.name}" contract side_effects.state_changes`);
    }
    for (const v of step.contract.side_effects.external_integrations) {
      externalIntegrations.add(v);
      record('external_integration', v, step.step_id,
        stepFacetEvidence(step, 'external_integration', v) ?? `step "${step.name}" contract side_effects.external_integrations`);
    }
  }

  // (d) Constraints that gate the flow. 'error' kind is already entry-scoped
  // to this flow's own chains (extractErrorConstraints) — always flow-level.
  // Everything else promotes only from a step with downstream steps to gate
  // (or from the only step of a single-step flow).
  const constraints: FacetConstraint[] = [];
  const constraintKeys = new Set<string>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const gatesDownstream = i < lastIdx || steps.length === 1;
    for (const c of step.contract.constraints) {
      if (c.kind !== 'error' && !gatesDownstream) continue;
      const key = `${c.kind}::${c.rule}`;
      if (!constraintKeys.has(key)) {
        constraintKeys.add(key);
        constraints.push(c);
      }
      record('constraint', c.rule, step.step_id, c.evidence);
    }
  }

  return {
    input,
    logic: steps.map(s => s.name).join(' -> '),
    side_effects: {
      state_changes: [...stateChanges],
      external_integrations: [...externalIntegrations],
    },
    output,
    constraints,
    ...(interiorInputs.size > 0 ? { internal_inputs_count: interiorInputs.size } : {}),
    ...(interiorOutputs.size > 0 ? { internal_outputs_count: interiorOutputs.size } : {}),
    ...(provenanceByKey.size > 0
      ? {
          facet_provenance: sortFacetProvenance(
            [...provenanceByKey.values()].map(p => ({ ...p, contributed_by_step_ids: [...p.contributed_by_step_ids].sort() }))
          ),
        }
      : {}),
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
   *  NODE id it anchors on (real cas.entry_points). `node:`-anchored operations
   *  resolve by stripping the prefix instead — a capability-DECLARED operation
   *  anchor is evidence (deriveCapabilityOperationRoots trusts the same shape
   *  to root whole flows), so a flow passing through it exercises the
   *  capability (re-validation F3: excluding this shape made the
   *  supporting/observability vocabulary unreachable on real CAS, where
   *  operations are predominantly node-anchored). */
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
        // Real entry-point anchors resolve via the handler map; `node:`-anchored
        // operations (the common shape — capability ops anchored directly on a
        // function/method node) resolve by stripping the prefix. Without the
        // second form, interior matching silently never fired for node-anchored
        // ops while the primary op-match (which handles `node:`) did — so every
        // relationship collapsed to 'primary' (re-validation F3: 39/39 primary
        // on a fresh hosted analysis; the supporting/observability/operational
        // vocabulary was unreachable for node-anchored capabilities).
        const handlerNodeId = entryHandlerNodeIdByEpId.get(op.entry_point_id)
          ?? (op.entry_point_id?.startsWith('node:') ? op.entry_point_id.slice('node:'.length) : undefined);
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

// ---------------------------------------------------------------------------
// STEP↔CODE MAPPINGS (D1) — typed many-to-many mappings from a step to the
// code regions that realize it (docs/SEMANTIC-MODEL.md, Step). Deterministic:
// every relationship is grounded in a fact the CAS already computed (the same
// facts C1's step-graph edges and D2's facet provenance cite).
// ---------------------------------------------------------------------------

/** Sane per-step cap on code mappings — a step's segment is already bounded by
 *  maxFunctionsPerFlow, so this only guards a pathological many-relationship
 *  blowup. Overflow is reported honestly via `code_mappings_truncated`. */
const STEP_CODE_MAPPING_CAP = 50;

/** Per-CAS evidence indexes for the D1 mapping rules that aren't already
 *  indexed elsewhere: try-catch pattern membership (→ 'handles_failure') and
 *  data-entity invariant enforcement (→ 'validates'). node id → the concrete
 *  evidence string. Facts only; built once per CAS. */
function buildStepMappingEvidence(cas: CASOutput): {
  tryCatchEvidence: Map<string, string>;
  invariantEvidence: Map<string, string>;
} {
  const tryCatchEvidence = new Map<string, string>();
  for (const p of cas.patterns || []) {
    if (!p.name.toLowerCase().includes('try-catch')) continue;
    for (const id of p.instances || []) {
      if (!tryCatchEvidence.has(id)) {
        tryCatchEvidence.set(id, `node is an instance of pattern "${p.name}" — sits on a catch/failure-handling path`);
      }
    }
  }
  const invariantEvidence = new Map<string, string>();
  for (const entity of cas.data_entities || []) {
    for (const inv of entity.invariants || []) {
      for (const id of inv.enforced_by || []) {
        if (!invariantEvidence.has(id)) {
          invariantEvidence.set(id, `enforces data_entity "${entity.name}" invariant: ${inv.description}`);
        }
      }
    }
  }
  return { tryCatchEvidence, invariantEvidence };
}

/** The code region for a node: node-level always; file + line_range only when
 *  the node carries the real span facts — never invented. */
function codeRegionFor(node: CASNode): StepCodeRegion {
  const region: StepCodeRegion = { node_id: node.id };
  if (node.source?.file) region.file = node.source.file;
  const line = node.source?.line;
  const endLine = node.source?.end_line;
  if (typeof line === 'number' && typeof endLine === 'number' && endLine >= line) {
    region.line_range = [line, endLine];
  }
  return region;
}

/**
 * Derive the typed StepCodeMappings for one step's segment — the D1 rules
 * (see StepCodeRelationship for the rule table). Each node gets its specific
 * relationships when the facts support them; a node with NO specific
 * relationship falls back to the default ('implements' for a sole node,
 * 'partially_implements' in a multi-node segment). The same node may carry
 * multiple mappings (many-to-many within the step), and the same node mapped
 * into a different step/flow derives its relationships independently there
 * (many-to-many across steps). Deterministic: deduped per (node, relationship),
 * sorted (node_id, relationship), capped with an honest overflow count.
 * `sub_segments` is NEVER populated here (AI-only-or-absent).
 */
function deriveStepCodeMappings(args: {
  stepId: string;
  segNodes: CASNode[];
  isFirstStep: boolean;
  isTerminalStep: boolean;
  /** The flow root's handler node id — grounds 'initiates' on the first step. */
  rootNodeId?: string;
  /** Display ref for the entry point cited in the 'initiates' contribution. */
  rootEpRef?: string;
  /** Resolved terminus (terminal-chain flows only) — grounds 'completes'. */
  terminus?: { node_id: string; exit_point_id: string; kind: string };
  /** Neighboring segments' nodes — ground provides_input/consumes_output via
   *  data_lineage. Absent for the first/last step respectively. */
  prevNodes?: CASNode[];
  nextNodes?: CASNode[];
  exitPointsByNode: Map<string, CASExitPoint[]>;
  lineageByNode: Map<string, { writes: CASEntityLineage[]; reads: CASEntityLineage[] }>;
  entryPointsByNode: Map<string, CASEntryPoint[]>;
  conditionalOut: Map<string, string>;
  tryCatchEvidence: Map<string, string>;
  invariantEvidence: Map<string, string>;
}): { mappings: StepCodeMapping[]; truncated: number } {
  const {
    stepId, segNodes, isFirstStep, isTerminalStep, rootNodeId, rootEpRef, terminus,
    prevNodes, nextNodes, exitPointsByNode, lineageByNode, entryPointsByNode,
    conditionalOut, tryCatchEvidence, invariantEvidence,
  } = args;

  const byKey = new Map<string, StepCodeMapping>();
  const add = (node: CASNode, relationship: StepCodeRelationship, contribution: string) => {
    const key = `${node.id}\u0000${relationship}`;
    if (byKey.has(key)) return;
    byKey.set(key, {
      step_id: stepId,
      code_region: codeRegionFor(node),
      relationship,
      contribution,
      confidence: 1.0,
    });
  };

  // Entity names the neighboring steps' nodes read/write — the data_lineage
  // ground for provides_input/consumes_output. Empty sets → the rules never
  // fire (skipped, not fabricated).
  const nextReads = new Set<string>();
  for (const n of nextNodes || []) {
    for (const e of lineageByNode.get(n.id)?.reads || []) nextReads.add(e.entity_name);
  }
  const prevWrites = new Set<string>();
  for (const n of prevNodes || []) {
    for (const e of lineageByNode.get(n.id)?.writes || []) prevWrites.add(e.entity_name);
  }

  const multi = segNodes.length > 1;
  for (const node of segNodes) {
    let specific = false;
    const mark = (relationship: StepCodeRelationship, contribution: string) => {
      specific = true;
      add(node, relationship, contribution);
    };

    // initiates — the node bound to the flow's entry point (first step only).
    if (isFirstStep && rootNodeId !== undefined && node.id === rootNodeId) {
      mark('initiates', `bound to the flow's entry point${rootEpRef ? ` ${rootEpRef}` : ''} (root handler node)`);
    }
    // completes — the node resolving the flow's terminus (terminal step only).
    if (isTerminalStep && terminus && node.id === terminus.node_id) {
      mark('completes', `resolves the flow's terminus exit point ${terminus.exit_point_id} (${terminus.kind})`);
    }

    // validates — non-error constraint facts THIS node contributes (the same
    // facts D2's provenance cites): source guard clauses, entry-point auth/
    // validation facts, data-entity invariants enforced by the node.
    const srcGuard = extractConstraintsFromSource(node)[0];
    if (srcGuard) mark('validates', `enforces "${srcGuard.rule}" (guard clause in node source)`);
    for (const ep of entryPointsByNode.get(node.id) || []) {
      const hasAuth = Boolean(ep.security?.authenticated)
        || (ep.security?.guards || []).length > 0
        || (ep.security?.authorized_roles || ep.security?.roles || []).length > 0;
      if (hasAuth) mark('validates', `entry point "${ep.name}" carries auth guards (security facts)`);
      if ((ep.input?.validation || []).length > 0) {
        mark('validates', `entry point "${ep.name}" carries input.validation rules`);
      }
    }
    const invEv = invariantEvidence.get(node.id);
    if (invEv) mark('validates', invEv);

    // handles_failure — the node sits on a catch path (try-catch pattern instance).
    const tcEv = tryCatchEvidence.get(node.id);
    if (tcEv) mark('handles_failure', tcEv);

    // branches — the node has a conditional control-flow successor (the same
    // buildConditionalOutIndex evidence C1's 'branch' step-graph edges use).
    const branchEv = conditionalOut.get(node.id);
    if (branchEv) mark('branches', branchEv);

    // causes_effect / observes — the node's own exits + lineage writes (D2's
    // effects facts). Telemetry-only exits with no writes → 'observes' instead.
    const exits = exitPointsByNode.get(node.id) || [];
    const writes = lineageByNode.get(node.id)?.writes || [];
    const effectExit = exits.find(e => !TELEMETRY_EXIT_KINDS.has(e.type));
    if (effectExit) {
      const facet = ['database', 'cache', 'file'].includes(effectExit.type) ? 'state change' : 'external integration';
      mark('causes_effect', `exit point ${effectExit.id} (${effectExit.type}) on this node — ${facet}`);
    } else if (writes.length > 0) {
      mark('causes_effect', `data_lineage "${writes[0].entity_name}" writers include this node — state change`);
    }
    const telemetryExit = exits.find(e => TELEMETRY_EXIT_KINDS.has(e.type));
    if (telemetryExit && !effectExit && writes.length === 0) {
      mark('observes', `all exits on this node are telemetry kinds (exit point ${telemetryExit.id}, ${telemetryExit.type}) and it writes no entity`);
    }

    // provides_input / consumes_output — data_lineage-derivable ONLY.
    if (nextReads.size > 0) {
      const provided = writes.find(w => nextReads.has(w.entity_name));
      if (provided) {
        mark('provides_input', `writes "${provided.entity_name}" which the next step's nodes read (data_lineage)`);
      }
    }
    if (prevWrites.size > 0) {
      const reads = lineageByNode.get(node.id)?.reads || [];
      const consumed = reads.find(r => prevWrites.has(r.entity_name));
      if (consumed) {
        mark('consumes_output', `reads "${consumed.entity_name}" which the previous step's nodes wrote (data_lineage)`);
      }
    }

    // Default mapping when nothing more specific applied.
    if (!specific) {
      add(
        node,
        multi ? 'partially_implements' : 'implements',
        multi
          ? `one of ${segNodes.length} nodes realizing this step's segment ("${node.name}")`
          : `sole node of this step's segment ("${node.name}")`
      );
    }
  }

  const sorted = [...byKey.values()].sort((a, b) =>
    a.code_region.node_id.localeCompare(b.code_region.node_id)
    || a.relationship.localeCompare(b.relationship));
  if (sorted.length > STEP_CODE_MAPPING_CAP) {
    return { mappings: sorted.slice(0, STEP_CODE_MAPPING_CAP), truncated: sorted.length - STEP_CODE_MAPPING_CAP };
  }
  return { mappings: sorted, truncated: 0 };
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
function buildTerminalFlows(
  cas: CASOutput,
  opts: ComputeFlowConceptsOptions,
  /** Internal (continuation partner derivation): restrict to chains ending at
   *  these exit point ids. Set only by computeFlowConcepts when a seam pair's
   *  publisher falls outside the maxFlows window — derives JUST that publisher
   *  instead of the full uncapped set (which would blow the latency budget). */
  onlyExitIds?: Set<string>
): FlowConcept[] {
  let chains = (cas.call_chains || []).filter(c => c.chain_type === 'entry-to-exit' && c.exit_point);
  if (onlyExitIds && onlyExitIds.size > 0) {
    chains = chains.filter(c => c.exit_point?.exit_point_id && onlyExitIds.has(c.exit_point.exit_point_id));
  }
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
  const mappingEvidence = buildStepMappingEvidence(cas);
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
      const stepId = `flow::${chain.id}::step${i}`;
      // D1 typed step↔code mappings — grounded in the same facts as the step
      // graph (branches), D2 provenance (validates/causes_effect/observes) and
      // the resolved terminus (initiates/completes).
      const { mappings: codeMappings, truncated: mappingsTruncated } = deriveStepCodeMappings({
        stepId,
        segNodes: seg.nodes,
        isFirstStep: i === 0,
        isTerminalStep: i === segments.length - 1,
        rootNodeId: chain.entry_point.node_id,
        rootEpRef: rootEp?.id || chain.entry_point.entry_point_id,
        terminus: exit ? { node_id: terminusNodeId, exit_point_id: exit.id, kind: exit.type } : undefined,
        prevNodes: segments[i - 1]?.nodes,
        nextNodes: segments[i + 1]?.nodes,
        exitPointsByNode,
        lineageByNode,
        entryPointsByNode,
        conditionalOut,
        ...mappingEvidence,
      });
      const step: FlowStep = {
        step_id: stepId,
        order: i,
        name,
        description,
        description_source: 'deterministic-label',
        contract,
        functions,
        entities: entitiesForNodes(stepNodeIds, cas),
        ...(codeMappings.length > 0 ? { code_mappings: codeMappings } : {}),
        ...(mappingsTruncated > 0 ? { code_mappings_truncated: mappingsTruncated } : {}),
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
      // Provenance for terminus-folded facet entries: attributed to the step
      // whose functions contain the terminus node (the last step is the
      // fallback when the terminus node was skipped from the resolved path);
      // evidence = the resolved exit point itself (a fact already at hand).
      const terminusStep = [...steps].reverse().find(s => s.functions.some(f => f.function_id === terminusNodeId)) || steps[steps.length - 1];
      const terminusEvidence = `terminal chain ${chain.id} resolves exit point ${exit.id} (${exit.type} → ${produces})`;
      const stampTerminus = (facet: ProvenanceFacet, value: string) => {
        const existing = contract.facet_provenance?.find(p => p.facet === facet && p.value === value);
        if (existing) return; // a step already contributed this exact entry with real evidence.
        const entry: FacetProvenance = {
          facet, value, contributed_by_step_ids: [terminusStep.step_id],
          source: 'deterministic', evidence: terminusEvidence,
        };
        contract.facet_provenance = sortFacetProvenance([...(contract.facet_provenance || []), entry]);
      };
      const label = `${exit.type}:${produces}`;
      if (exit.type === 'database' || exit.type === 'cache' || exit.type === 'file') {
        if (!contract.side_effects.state_changes.includes(label)) {
          contract.side_effects.state_changes.push(label);
          stampTerminus('state_change', label);
        }
      } else {
        if (!contract.side_effects.external_integrations.includes(label)) {
          contract.side_effects.external_integrations.push(label);
          stampTerminus('external_integration', label);
        }
        // api / webhook / event terminals are the flow's response/emission —
        // record what it emits in Output too (deterministic, evidence-gated on
        // the resolved exit point).
        if (['api', 'webhook', 'event', 'navigation'].includes(exit.type)) {
          const out = exit.data?.output_type || `${exit.type} ${produces}`;
          if (!contract.output.includes(out)) {
            contract.output.push(out);
            stampTerminus('output', out);
          }
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
  // subflow. Evidence-gated + deterministic; no-op when no pair.
  //
  // PARTNER DERIVATION (re-validation F2): the maxFlows window is applied
  // DURING derivation, so a seam pair whose partner flow falls outside the
  // window used to be unstitchable — on a 3,600-entry-point repo a 20-flow
  // window made continuations near-unobservable. Deriving the FULL uncapped
  // union just to stitch would blow the latency budget (~9.5s on a whale), so
  // instead: seam pairs are computed first (one cheap pass over exit/entry
  // points), and ONLY the missing partners of in-window flows are derived —
  // the matched consumer entry points / publisher exit chains, nothing else.
  // Partners append past maxFlows deliberately: a continuation partner is part
  // of the SAME end-to-end flow, not an extra window slot.
  const pairs = pairPublishConsumeSeams(cas);
  if (pairs.length > 0) {
    const byExit = new Set(flows.map(f => f.terminus?.exit_point_id).filter(Boolean) as string[]);
    const byEntry = new Set(flows.map(f => f.entry_point));
    const missingConsumerEntryIds = new Set<string>();
    const missingPublisherExitIds = new Set<string>();
    for (const { exitId, entryId } of pairs) {
      if (byExit.has(exitId) && !byEntry.has(entryId)) missingConsumerEntryIds.add(entryId);
      if (byEntry.has(entryId) && !byExit.has(exitId)) missingPublisherExitIds.add(exitId);
    }
    const partnerOpts: ComputeFlowConceptsOptions = { ...opts, maxFlows: undefined };
    if (missingConsumerEntryIds.size > 0) {
      flows = [...flows, ...computeEntryPointFlows(cas, partnerOpts, { onlyEntryKeys: missingConsumerEntryIds })];
    }
    if (missingPublisherExitIds.size > 0) {
      const partnerPublishers = buildTerminalFlows(cas, partnerOpts, missingPublisherExitIds)
        .filter(p => !flows.some(f => f.flow_id === p.flow_id));
      flows = [...flows, ...partnerPublishers];
    }
  }
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
  unionOpts: { excludeEntryKeys?: Set<string>; significantOnly?: boolean; onlyEntryKeys?: Set<string> } = {}
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
  if (unionOpts.onlyEntryKeys && unionOpts.onlyEntryKeys.size > 0) {
    // Internal (continuation partner derivation): derive JUST these consumer
    // entry points — they are seam-evidence-matched, so the significance
    // filter does not apply to them.
    const only = unionOpts.onlyEntryKeys;
    entryPoints = entryPoints.filter(ep => only.has(ep.id) || only.has(ep.handler?.node_id || ep.source_node));
  }
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

  // SIGNIFICANCE-FIRST WINDOW ORDER (re-validation: flow-entity starvation):
  // the maxFlows window used to slice entry points in raw array order, so on a
  // test-heavy CAS (e.g. 972/976 'test' entries) the whole window filled with
  // test-suite roots — which have no forward reach into the call graph — while
  // the synthesized capability-operation roots (appended after the real
  // entries) never entered the window. Result: 0/100 flows with entities, and
  // every capability↔flow role starved. Order the candidates by significance
  // CLASS, stable within class (original array order), so the window prefers
  // product entries: (0) real non-test entry points, (1) synthesized
  // capability-operation roots, (2) test entries. Deterministic — a pure
  // stable class sort over facts already on each candidate, no sampling.
  const entryClassRank = (ep: CASEntryPoint): number =>
    ep.type === 'test' ? 2 : synthesizedRootIds.has(ep.id) ? 1 : 0;
  const entryOriginalIndex = new Map(entryPoints.map((ep, i) => [ep.id, i]));
  entryPoints = [...entryPoints].sort((a, b) =>
    (entryClassRank(a) - entryClassRank(b)) ||
    (entryOriginalIndex.get(a.id)! - entryOriginalIndex.get(b.id)!)
  );

  const exitPointsByNode = buildExitPointIndex(cas);
  const lineageByNode = buildLineageIndex(cas);
  const conditionalOut = buildConditionalOutIndex(cas);
  const deleterNodeIds = buildDeleterNodeIds(cas);
  const mappingEvidence = buildStepMappingEvidence(cas);

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
      const stepId = `${ep.id}::step${i}`;
      // D1 typed step↔code mappings. No resolved terminus on entry-point-rooted
      // flows — 'completes' is never derived here (omitted, not fabricated).
      const { mappings: codeMappings, truncated: mappingsTruncated } = deriveStepCodeMappings({
        stepId,
        segNodes: seg.nodes,
        isFirstStep: i === 0,
        isTerminalStep: i === segments.length - 1,
        rootNodeId: ep.handler?.node_id || ep.source_node,
        rootEpRef: ep.id,
        prevNodes: segments[i - 1]?.nodes,
        nextNodes: segments[i + 1]?.nodes,
        exitPointsByNode,
        lineageByNode,
        entryPointsByNode,
        conditionalOut,
        ...mappingEvidence,
      });
      const step: FlowStep = {
        step_id: stepId,
        order: i,
        name,
        description,
        description_source: 'deterministic-label',
        contract,
        functions,
        entities: entitiesForNodes(stepNodeIds, cas),
        ...(codeMappings.length > 0 ? { code_mappings: codeMappings } : {}),
        ...(mappingsTruncated > 0 ? { code_mappings_truncated: mappingsTruncated } : {}),
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
    const telemetryStepIds: string[] = [];
    for (const step of flow.steps) {
      const stepNodeIds = step.functions.map(f => f.function_id);
      for (const id of stepNodeIds) flowNodeIds.add(id);
      const stepTel = telemetryForUnit(index, stepNodeIds);
      if (stepTel) {
        step.contract.telemetry = stepTel;
        telemetryStepIds.push(step.step_id);
      }
    }
    const flowTel = telemetryForUnit(index, flowNodeIds, [flow.entry_point]);
    if (flowTel) {
      flow.contract.telemetry = flowTel;
      // Facet provenance for the end-to-end telemetry join (facet 'telemetry'):
      // which steps carried matching observations, and the observation source.
      // Deterministic — real observations only; never stamped when no match.
      const entry: FacetProvenance = {
        facet: 'telemetry',
        value: flowTel.static_id,
        contributed_by_step_ids: [...telemetryStepIds].sort(),
        source: 'deterministic',
        evidence: `runtime observations (source: ${flowTel.source}) matched this flow's entry point / nodes`,
      };
      const existing = (flow.contract.facet_provenance || []).filter(p => !(p.facet === 'telemetry' && p.value === entry.value));
      flow.contract.facet_provenance = sortFacetProvenance([...existing, entry]);
    }
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
