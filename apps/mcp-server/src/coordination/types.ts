/**
 * Coordination fabric — pure data model (§4 of docs/SPEC-COORDINATION-FABRIC.md).
 *
 * This module is transport-free and IO-free: no reads from storage.ts, no HTTP,
 * no MCP wiring. Everything here is plain data + pure functions operating on
 * data passed in by a caller (see arbiter.ts / collision.ts / presence.ts).
 */

import type { SymbolChange } from './conceptual-conflict';

/** Kind of agent holding a claim or presence entry (WS-C). */
export type AgentKind = 'claude' | 'cursor' | 'codex' | 'human' | 'other';

/** Lifecycle status of a WorkClaim (WS-C). */
export type WorkClaimStatus = 'active' | 'released' | 'superseded' | 'expired';

/**
 * Conceptual coordinates for a claim's scope (§4 SPEC-CONCEPTUAL-LAYER.md,
 * "conceptual vocabulary for the fabric"): the FLOW/STEP/CAPABILITY/ENTITY an
 * agent is working within, alongside (never instead of) its file paths and
 * symbols. Entirely optional/additive — every field here may be omitted, and
 * a claim with none of them behaves exactly as it did before this type
 * existed (pure file/symbol coordination).
 *
 * Two provenances populate this:
 *  - DECLARED: the caller names its own flow/step/capability/entity directly
 *    (e.g. "I own the Charge step of the Checkout flow").
 *  - DERIVED: `conceptual-scope.ts`'s `deriveConceptualCoordinate` maps the
 *    claim's declared paths/symbols onto a real FlowConcept/FlowStep via
 *    `getFlowConcepts`, so a plain file-based claim auto-acquires conceptual
 *    coordinates without the caller having to know flow vocabulary at all.
 *    DETERMINISTIC-FIRST: derived coordinates always come from a real
 *    flow-concepts mapping — never guessed when no flow claims the file.
 */
export interface ConceptualCoordinate {
  /** SystemCapability id (CAS system_capabilities, repo- or workspace-level), e.g. "cap::checkout". */
  capability_id?: string;
  /** FlowConcept id (packages/analyzer-core .../flow-concepts.ts), e.g. "flow::ep_checkout_post". */
  flow_id?: string;
  /** FlowStep id within that flow, e.g. "ep_checkout_post::step2". */
  step_id?: string;
  /** Data entity name(s) this work touches the CONSTRAINTS of (invariants,
   *  validation rules) — a conceptual conflict can exist across two agents in
   *  DIFFERENT files if both touch the same entity's constraints (§4: "same
   *  entity's constraints" case, semantic overlap textual diff can't see). */
  entities?: string[];
  /** How this coordinate was populated: 'declared' when the caller named it
   *  directly, 'derived' when `conceptual-scope.ts` mapped it from
   *  paths/symbols via getFlowConcepts. Absent on hand-built claims from
   *  before this field existed. */
  source?: 'declared' | 'derived';
}

/**
 * Kind of contract surface a lane produces (Coordination Engine §3).
 * Deliberately the vocabulary the analysis already speaks (interface
 * signatures / ICELOT contracts) — no new contract syntax was invented.
 */
export type ContractKind = 'export' | 'signature' | 'endpoint' | 'type' | 'event' | 'schema';

/**
 * A contract this lane will create/change (DECLARED), or has been observed
 * changing (OBSERVED) — Coordination Engine §3 "structured intent, reduced".
 *
 * CONTRACT IDENTITY is `(kind, name, path?)`. Path-qualified matching is
 * preferred; a name-only match (a consumer names a contract without a path, or
 * two same-named contracts exist) is real but reported at LOWER CONFIDENCE and
 * labeled as such — see `matchContract` in contract-intent.ts.
 *
 * `signature` is a STRING on purpose: agents write and read it. The
 * deterministic drift comparator works on ambient-captured `SymbolChange[]`,
 * never on parsing this string.
 *
 * SCOPE HONESTY: this shape describes signature-shaped surfaces only. It
 * cannot express (and drift detection cannot detect) semantic/behavioral
 * change behind an unchanged signature — see `notes` for the human-carried
 * part, and `detectDeclaredContractDrift`'s header for the explicit limit.
 */
export interface DeclaredContract {
  kind: ContractKind;
  /** e.g. "buildOutcomeRecord", "GET /v1/coordination/outcomes". */
  name: string;
  /** Where it lives / will live. Absent on a not-yet-localized declaration. */
  path?: string;
  /** Legible shape: "(ws: string, opts?: {limit}) => OutcomeRecord[]". */
  signature?: string;
  /** Semantics a signature can't carry ("throws on empty ws"). */
  notes?: string;
  /**
   * `'declared'` = the lane said it would produce this (intent).
   * `'observed'` = auto-lifted from ambient capture (evidence of activity).
   * An explicit declaration always WINS over an observation for the same
   * identity; both are visible on the board, labeled (see `mergeContracts`).
   * Absent is treated as `'declared'` (the pre-auto-derivation default).
   */
  status?: 'declared' | 'observed';
}

/**
 * The unit of "announced intent" an agent registers before acting.
 * Last-writer-wins per `claim_id`, ordered by the monotonic `seq` (presence.ts).
 */
export interface WorkClaim {
  claim_id: string;
  seq: number;
  /**
   * WRITER-OWNED monotonic per-claim version (Coordination Engine wave 1).
   * Assigned by the store that first records the claim on behalf of its writer
   * (local-store's appendClaim: max prior version for this claim_id + 1) and
   * ECHOED VERBATIM through every publish/replication hop — never re-assigned
   * by a receiver. Conflict resolution for the same `claim_id` across stores
   * keys on THIS field, not on `seq`: `seq` is a per-board arrival counter and
   * two boards' seq domains are incomparable (a stale local entry at seq 900
   * must not beat a fresher remote entry at seq 12). LEGACY: entries without
   * `version` (written before this field existed) fall back to seq-based LWW —
   * see `reduceClaimLog` in presence.ts.
   */
  version?: number;
  workspace_id: string;
  agent_id: string;
  agent_kind: AgentKind;
  scope: {
    repo: string;
    paths: string[];
    symbols: string[];
    capability?: string;
    /** Optional conceptual coordinates, additive to paths/symbols/capability
     *  above — see `ConceptualCoordinate`. */
    concept?: ConceptualCoordinate;
  };
  intent: string;
  status: WorkClaimStatus;
  created_at: string;
  ttl_ms: number;
  heartbeat_at: string;
  base_commit?: string;
  branch?: string;
  /** Organization scope (§WS-F tenancy). Optional/additive — see `TenantScoped` in security.ts. */
  org_id?: string;
  /**
   * Contracts this lane will create/change (Coordination Engine §3). Mixed
   * provenance: explicitly declared entries plus entries auto-lifted from this
   * lane's ambient `SymbolChange[]` with `status:'observed'`. Optional and
   * additive — an absent `produces` reads exactly as it did before this field
   * existed. Peers build against DECLARED contracts before they are written
   * (the manually-proven 2026-07-20 pattern, now a fabric primitive).
   */
  produces?: DeclaredContract[];
  /**
   * Plain contract NAMES this lane builds against (Coordination Engine §3).
   * Populated explicitly, or auto-recorded when this lane's ambient diff
   * references a contract a PEER claim declares/produces. This is the edge
   * that makes drift surprises deliverable to the lanes that actually care —
   * drift detection compares one producer's diff against ITS consumers, never
   * against every claim.
   */
  consumes?: string[];
}

/**
 * DERIVED, never declared (Coordination Engine §3: "phase is derived, never
 * declared"). Display-only: no writer reports it, nothing branches on it, and
 * it is recomputed at read time so it can never go stale.
 *  - `exploring`  — an active claim with no observed ambient edits yet
 *                   (frequently also a path-less claim: an arriving agent that
 *                   has not localized its footprint).
 *  - `building`   — ambient edits observed under this claim.
 *  - `verifying`  — test-file telemetry observed under this claim.
 */
export type DerivedPhase = 'exploring' | 'building' | 'verifying';

/** A workspace's live agent roster (WS-C `presence.ts` / `get_active_agents`). */
export interface AgentPresence {
  agent_id: string;
  agent_kind: AgentKind;
  workspace: string;
  last_seen: string;
  scope: {
    repo: string;
    paths: string[];
    symbols: string[];
    capability?: string;
    concept?: ConceptualCoordinate;
  };
  base_commit?: string;
}

/** Compact summary of an agent's uncommitted working-tree state (WS-B, §4). */
export interface InFlightSnapshot {
  workspace: string;
  agent_id: string;
  base_commit: string;
  branch?: string;
  diff_context: string;
  touched: {
    entities: string[];
    routes: string[];
    contracts: string[];
    symbols: string[];
  };
  updated_at: string;
  /** Organization scope (§WS-F tenancy). Optional/additive — see `TenantScoped` in security.ts. */
  org_id?: string;
  /**
   * Ambiently-captured per-symbol before/after changes (Fabric-v2 #2, §1.7:
   * "ambient in-flight capture"), produced by
   * `coordination/in-flight-capture.ts`'s `captureInFlightChanges()` from the
   * agent's actual git working-tree diff — NOT agent-self-reported. Optional
   * and additive: a snapshot with no `changes` (older publisher, or a
   * non-TS/JS-only diff that only produced unknown-change entries) simply
   * contributes nothing extra to conceptual-conflict detection, exactly like
   * before this field existed. Imports `SymbolChange` from
   * `conceptual-conflict.ts` rather than redefining it, so this snapshot's
   * `changes` can be fed directly into `detectConceptualConflicts` alongside
   * (or instead of) an agent's self-reported `check_conceptual_conflicts` call.
   */
  changes?: SymbolChange[];
}

/** A minimal CAS call/data edge, enough for blast-radius overlap (matches CASEdge shape). */
export interface CasEdgeRef {
  id: string;
  source: string;
  target: string;
  type: string;
}

/** A minimal workspace-level-CAS capability, enough for capability-name matching (matches WorkspaceCapability). */
export interface WorkspaceCapabilityRef {
  id: string;
  name: string;
  project_ids?: string[];
}

/** Verdict returned by `arbitrate()` (WS-C). */
export type ArbitrationVerdict = 'granted' | 'conflict' | 'duplicate';

/** Kind of overlap evidence backing a `conflict` verdict. */
export type ConflictKind = 'path' | 'symbol' | 'capability' | 'blast_radius';

export interface ArbitrationResult {
  verdict: ArbitrationVerdict;
  with_claim?: WorkClaim;
  kind?: ConflictKind;
  evidence?: string[];
}

/** One flagged duplicate-work finding (WS-D detector 1). */
export interface DuplicateFinding {
  claim_id: string;
  with_claim_id: string;
  capability?: string;
  evidence: string[];
}

/** One flagged edit-overlap finding (WS-D detector 2). */
export interface OverlapFinding {
  claim_id: string;
  with_claim_id: string;
  paths: string[];
  symbols: string[];
  evidence: string[];
}

/** One flagged in-flight contract-drift finding (WS-D detector 3). */
export interface DriftFinding {
  agent_id: string;
  with_agent_id: string;
  contracts: string[];
  evidence: string[];
}

/** One flagged cross-agent blast-radius finding (WS-D detector 4). */
export interface BlastIntersectionFinding {
  claim_id: string;
  with_claim_id: string;
  symbols: string[];
  evidence: string[];
}

/** Output of `detectCollisions()` (WS-D). */
export interface CollisionReport {
  duplicates: DuplicateFinding[];
  overlaps: OverlapFinding[];
  drifts: DriftFinding[];
  blast_intersections: BlastIntersectionFinding[];
}

// ---------------------------------------------------------------------------
// Intent-aware merge (Fabric-v2 #1, §1.7 SPEC-COORDINATION-FABRIC-V2
// primitive 5, "the art of merge"). The real shapes (`MergePlan`,
// `AutoMergeableEntry`, `NeedsResolutionEntry`, `DuplicateWorkEntry`,
// `MergePlanSummary`) live in `coordination/intent-merge.ts`, which — like
// `conceptual-conflict.ts` — is kept transport/IO-free and defines its own
// types rather than this pure-data module reaching into it. Re-exported here
// purely so callers that already `import type { ... } from './types'` for
// every other coordination-fabric shape have one place to find this one too.
// ---------------------------------------------------------------------------
export type {
  MergePlan,
  AutoMergeableEntry,
  NeedsResolutionEntry,
  DuplicateWorkEntry,
  MergePlanSummary,
} from './intent-merge';
