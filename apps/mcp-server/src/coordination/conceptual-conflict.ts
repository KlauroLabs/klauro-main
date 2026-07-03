/**
 * Conceptual-conflict detection (§1.7 of docs/SPEC-COORDINATION-FABRIC-V2.md,
 * "the conflict hierarchy"): the fabric's crown-jewel value.
 *
 * Textual/merge conflicts (same lines edited) are git's job — cheap, visible,
 * mechanical, NOT this module's concern. A CONCEPTUAL conflict is two
 * locally-valid changes that are JOINTLY INCOHERENT: each change compiles,
 * passes review, and merges cleanly on its own, but together they break the
 * system. Detecting this requires code SEMANTICS (the CAS call graph + types)
 * plus agent INTENT — exactly the two things git/linters/textual-merge don't
 * have, and exactly what this coordination fabric uniquely carries.
 *
 * Cardinal rule (see CLAUDE.md "Klauro deterministic facts + AI"): deterministic
 * structural facts first, AI interpretation optional flavor, never the core.
 * Detectors 1-4 below are fully deterministic and stand on their own with zero
 * AI. Detector 5 (invariant-conflict) is AI-flavored and MUST degrade to a
 * no-op when no interpreter is supplied — never gates the other four.
 *
 * Pure module: no IO, no transport, no storage reads. Callers pass in the
 * AgentInFlightState list and a CAS-shaped object (via query.ts helpers or a
 * raw { nodes, edges } shape); see conceptual-conflict-demo.ts for a real
 * end-to-end example against an analyzeForBench() CAS.
 */

// ---------------------------------------------------------------------------
// Input model
// ---------------------------------------------------------------------------

export type SymbolChangeKind =
  | 'signature'
  | 'return_type'
  | 'nullability'
  | 'param'
  | 'rename'
  | 'split'
  | 'move'
  | 'delete'
  | 'body'
  | 'add';

export interface SymbolChangeShape {
  signature?: string;
  return_type?: string;
  nullable?: boolean;
  name?: string;
  /** For 'split': the new symbol_ids this symbol was divided into. */
  split_into?: string[];
  /** For 'body': a coarse tag of what the body edit does, used by the
   *  behavior-drift heuristic (detector 4). Purely additive/best-effort. */
  body_tags?: BodyTag[];
}

export type BodyTag = 'early-return' | 'guard' | 'appends-after' | 'other';

export interface SymbolChange {
  symbol_id: string;
  name: string;
  file: string;
  change_kind: SymbolChangeKind;
  before?: SymbolChangeShape;
  after?: SymbolChangeShape;
}

export interface AgentInFlightState {
  agent_id: string;
  intent: string;
  changes: SymbolChange[];
}

export type ConceptualConflictKind =
  | 'contract-divergence'
  | 'duplicate-work'
  | 'structural-divergence'
  | 'invariant-conflict'
  | 'behavior-drift';

export interface ConceptualConflict {
  kind: ConceptualConflictKind;
  severity: 'high' | 'medium' | 'low';
  agents: string[];
  symbol: string;
  /**
   * BOTH sides of the conflicting pair's symbol_ids, additive to `symbol`
   * (kept for backward compat — existing consumers reading `.symbol` are
   * unaffected). `symbol` only ever named one side (e.g. duplicate-work's
   * both-add case has two distinct symbol_ids for the same logical name;
   * contract-divergence has the changed symbol plus the caller being edited).
   * `symbol_ids` carries every symbol_id involved in this specific finding,
   * in the order the detector discovered them. Always non-empty and always
   * includes `symbol` as its first element.
   */
  symbol_ids?: string[];
  file?: string;
  /** Human-readable WHY it's incoherent — not just "these overlap". */
  explanation: string;
  /** true = git would NOT catch this (the whole point of this detector). */
  passes_textual_merge: boolean;
  evidence: string[];
}

/**
 * Minimal CAS shape this module needs: nodes with id/name and edges with
 * source/target/type ("calls" edges specifically). Matches the real CASOutput
 * (see query.ts) structurally, so a real CAS can be passed directly, or a
 * lightweight fixture built by hand.
 */
export interface ConflictCasNode {
  id: string;
  name: string;
}

export interface ConflictCasEdge {
  source: string;
  target: string;
  type: string;
}

export interface ConflictCas {
  nodes: ConflictCasNode[];
  edges: ConflictCasEdge[];
}

// ---------------------------------------------------------------------------
// Optional AI-flavored invariant interpreter (detector 5). Deterministic
// detectors 1-4 never depend on this; absence of an interpreter simply
// disables detector 5 (clean degrade, per the cardinal rule).
// ---------------------------------------------------------------------------

export interface InvariantAssertion {
  symbol: string;
  invariant: 'idempotent' | 'immutable' | 'non-null' | string;
}

/** Pluggable, optional. Given an agent's declared intent, extract any
 *  invariant assertions it makes ("now idempotent", "always non-null", ...).
 *  Returns [] when nothing is asserted or when no interpreter is wired up. */
export type InvariantInterpreter = (intent: string, symbol: string) => InvariantAssertion[];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Callers of `symbolNameOrId` one hop back, via CAS "calls" edges. Matches
 *  by node id OR name so callers can pass either a symbol_id or a bare name. */
function getCallerIds(cas: ConflictCas, symbolNameOrId: string): string[] {
  const nodesById = new Map(cas.nodes.map((n) => [n.id, n]));
  const targetIds = new Set<string>();
  for (const n of cas.nodes) {
    if (n.id === symbolNameOrId || n.name === symbolNameOrId) targetIds.add(n.id);
  }
  if (targetIds.size === 0) targetIds.add(symbolNameOrId);

  const callerIds = new Set<string>();
  for (const edge of cas.edges) {
    if (edge.type !== 'calls') continue;
    if (targetIds.has(edge.target)) callerIds.add(edge.source);
  }
  // Resolve to names too, so callers whose changes reference a node by name
  // (rather than id) still match.
  const resolved = new Set<string>();
  for (const id of callerIds) {
    resolved.add(id);
    const node = nodesById.get(id);
    if (node) resolved.add(node.name);
  }
  return [...resolved];
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

const CONTRACT_KINDS = new Set<SymbolChangeKind>(['signature', 'return_type', 'nullability', 'param']);
const STRUCTURAL_KINDS = new Set<SymbolChangeKind>(['rename', 'split', 'move', 'delete']);

function contractShapeChanged(before?: SymbolChangeShape, after?: SymbolChangeShape): string[] {
  const notes: string[] = [];
  if (!before || !after) return notes;
  if (before.signature !== undefined && after.signature !== undefined && before.signature !== after.signature) {
    notes.push(`signature: ${before.signature} -> ${after.signature}`);
  }
  if (before.return_type !== undefined && after.return_type !== undefined && before.return_type !== after.return_type) {
    notes.push(`return_type: ${before.return_type} -> ${after.return_type}`);
  }
  if (before.nullable !== undefined && after.nullable !== undefined && before.nullable !== after.nullable) {
    notes.push(`nullable: ${before.nullable} -> ${after.nullable}`);
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Detector 1: contract-divergence
// ---------------------------------------------------------------------------

/**
 * Agent A changes symbol X's signature/return_type/nullability/params. Agent
 * B's in-flight changes include a CALLER of X (by the CAS call graph) that B
 * is editing without accounting for the new contract. The canonical example:
 * A retypes `getUser(): User | null` to `getUser(): User` (or vice versa);
 * B is concurrently editing a caller that still does `if (!getUser())`.
 * Git sees two disjoint, individually-valid diffs and merges them cleanly —
 * passes_textual_merge is always true here; that IS the point.
 */
function detectContractDivergence(
  states: AgentInFlightState[],
  cas: ConflictCas
): ConceptualConflict[] {
  const findings: ConceptualConflict[] = [];
  const seen = new Set<string>();

  for (const agentA of states) {
    for (const changeA of agentA.changes) {
      if (!CONTRACT_KINDS.has(changeA.change_kind)) continue;
      const shapeNotes = contractShapeChanged(changeA.before, changeA.after);
      if (shapeNotes.length === 0) continue;

      const callerIds = new Set(getCallerIds(cas, changeA.symbol_id));
      if (callerIds.size === 0) {
        for (const c of getCallerIds(cas, changeA.name)) callerIds.add(c);
      }

      for (const agentB of states) {
        if (agentB.agent_id === agentA.agent_id) continue;
        for (const changeB of agentB.changes) {
          const touchesCallSite =
            callerIds.has(changeB.symbol_id) || callerIds.has(changeB.name);
          if (!touchesCallSite) continue;

          const key = pairKey(agentA.agent_id, agentB.agent_id) + '|' + changeA.symbol_id + '|' + changeB.symbol_id;
          if (seen.has(key)) continue;
          seen.add(key);

          findings.push({
            kind: 'contract-divergence',
            severity: 'high',
            agents: [agentA.agent_id, agentB.agent_id],
            symbol: changeA.symbol_id,
            symbol_ids: [changeA.symbol_id, changeB.symbol_id],
            file: changeA.file,
            explanation:
              `${agentA.agent_id} changed ${changeA.name}'s contract (${shapeNotes.join(', ')}) ` +
              `while ${agentB.agent_id} is concurrently editing ${changeB.name}, a caller of ${changeA.name}, ` +
              `which likely still assumes the OLD contract. Each diff is locally valid and merges cleanly; ` +
              `together they are incoherent.`,
            passes_textual_merge: true,
            evidence: [
              `contract_change:${changeA.symbol_id}:${shapeNotes.join('|')}`,
              `caller_edit:${changeB.symbol_id}`,
              `cas_edge:calls:${changeB.symbol_id}->${changeA.symbol_id}`,
            ],
          });
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Detector 2: duplicate-work
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'add', 'in', 'on', 'with',
  'is', 'are', 'be', 'this', 'that', 'it', 'as', 'at', 'by', 'so', 'we',
]);

function intentTokens(intent: string): Set<string> {
  return new Set(
    intent
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
  );
}

function intentOverlaps(a: string, b: string): boolean {
  const ta = intentTokens(a);
  const tb = intentTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const smaller = Math.min(ta.size, tb.size);
  return smaller > 0 && shared / smaller >= 0.34;
}

/**
 * A and B both change the SAME symbol with overlapping intent, or both ADD a
 * symbol with the same name — the fleet is doing the same work twice.
 */
function detectDuplicateWork(states: AgentInFlightState[]): ConceptualConflict[] {
  const findings: ConceptualConflict[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < states.length; i++) {
    for (let j = i + 1; j < states.length; j++) {
      const a = states[i];
      const b = states[j];
      for (const changeA of a.changes) {
        for (const changeB of b.changes) {
          const sameSymbol = changeA.symbol_id === changeB.symbol_id;
          const bothAdd =
            changeA.change_kind === 'add' &&
            changeB.change_kind === 'add' &&
            changeA.name === changeB.name;
          if (!sameSymbol && !bothAdd) continue;
          if (!intentOverlaps(a.intent, b.intent)) continue;

          const key = pairKey(a.agent_id, b.agent_id) + '|' + changeA.symbol_id + '|' + changeB.symbol_id;
          if (seen.has(key)) continue;
          seen.add(key);

          findings.push({
            kind: 'duplicate-work',
            severity: 'medium',
            agents: [a.agent_id, b.agent_id],
            symbol: changeA.symbol_id,
            symbol_ids: [changeA.symbol_id, changeB.symbol_id],
            file: changeA.file,
            explanation:
              `${a.agent_id} ("${a.intent}") and ${b.agent_id} ("${b.intent}") are both ` +
              `${bothAdd ? 'adding' : 'changing'} ${changeA.name} with overlapping intent — the fleet ` +
              `is likely doing the same work twice.`,
            passes_textual_merge: true,
            evidence: [
              `shared_symbol:${changeA.symbol_id}`,
              `intent_overlap:${a.agent_id}~${b.agent_id}`,
            ],
          });
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Detector 3: structural-divergence
// ---------------------------------------------------------------------------

/**
 * Agent A renames/splits/moves/deletes symbol X. Agent B ADDs a new reference
 * or caller to the OLD X (old name, or the old monolithic form) — B is
 * building on a structure A is actively dissolving.
 */
function detectStructuralDivergence(states: AgentInFlightState[]): ConceptualConflict[] {
  const findings: ConceptualConflict[] = [];
  const seen = new Set<string>();

  for (const agentA of states) {
    for (const changeA of agentA.changes) {
      if (!STRUCTURAL_KINDS.has(changeA.change_kind)) continue;

      // Names that no longer resolve after A's change: the pre-change name,
      // plus (for renames) the before.name if present.
      const dissolvedNames = new Set<string>([changeA.name]);
      if (changeA.before?.name) dissolvedNames.add(changeA.before.name);

      for (const agentB of states) {
        if (agentB.agent_id === agentA.agent_id) continue;
        for (const changeB of agentB.changes) {
          if (changeB.change_kind !== 'add') continue;
          // B's added symbol references the old structure if its signature/
          // body mentions the dissolved name, or it explicitly targets the
          // same symbol_id as the pre-change symbol.
          const referencesOld =
            changeB.symbol_id === changeA.symbol_id ||
            (changeB.after?.signature ? [...dissolvedNames].some((n) => changeB.after!.signature!.includes(n)) : false);
          if (!referencesOld) continue;

          const key = pairKey(agentA.agent_id, agentB.agent_id) + '|' + changeA.symbol_id + '|' + changeB.symbol_id;
          if (seen.has(key)) continue;
          seen.add(key);

          findings.push({
            kind: 'structural-divergence',
            severity: 'high',
            agents: [agentA.agent_id, agentB.agent_id],
            symbol: changeA.symbol_id,
            symbol_ids: [changeA.symbol_id, changeB.symbol_id],
            file: changeA.file,
            explanation:
              `${agentA.agent_id} is ${changeA.change_kind === 'split' ? 'splitting' : changeA.change_kind === 'delete' ? 'deleting' : changeA.change_kind === 'move' ? 'moving' : 'renaming'} ` +
              `${changeA.name}${changeA.after?.split_into?.length ? ` into ${changeA.after.split_into.join(', ')}` : ''}, ` +
              `while ${agentB.agent_id} adds ${changeB.name}, which references the OLD structure ` +
              `("${changeA.name}") that A is dissolving. Each diff merges cleanly; the composed result ` +
              `references a structure that no longer exists in the intended shape.`,
            passes_textual_merge: true,
            evidence: [
              `structural_change:${changeA.change_kind}:${changeA.symbol_id}`,
              `new_reference_to_old_structure:${changeB.symbol_id}`,
            ],
          });
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Detector 4: behavior-drift (best-effort heuristic)
// ---------------------------------------------------------------------------

/**
 * Both agents change the SAME symbol's BODY in ways that compose to
 * likely-unintended behavior. Heuristic, tag-based: if A's body change adds
 * an early-return/guard and B's body change appends code assumed to run
 * unconditionally after, the composed function may skip B's code entirely
 * on the guarded path. This is inherently approximate — flagged medium, and
 * explicitly labeled heuristic in the explanation so callers don't over-trust
 * it the way they would a deterministic contract-divergence finding.
 */
function detectBehaviorDrift(states: AgentInFlightState[]): ConceptualConflict[] {
  const findings: ConceptualConflict[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < states.length; i++) {
    for (let j = i + 1; j < states.length; j++) {
      const a = states[i];
      const b = states[j];
      for (const changeA of a.changes) {
        if (changeA.change_kind !== 'body') continue;
        const tagsA = changeA.after?.body_tags ?? [];
        const addsGuard = tagsA.includes('early-return') || tagsA.includes('guard');
        if (!addsGuard) continue;

        for (const changeB of b.changes) {
          if (changeB.change_kind !== 'body') continue;
          if (changeB.symbol_id !== changeA.symbol_id) continue;
          const tagsB = changeB.after?.body_tags ?? [];
          if (!tagsB.includes('appends-after')) continue;

          const key = pairKey(a.agent_id, b.agent_id) + '|' + changeA.symbol_id;
          if (seen.has(key)) continue;
          seen.add(key);

          findings.push({
            kind: 'behavior-drift',
            severity: 'medium',
            agents: [a.agent_id, b.agent_id],
            symbol: changeA.symbol_id,
            symbol_ids: [changeA.symbol_id, changeB.symbol_id],
            file: changeA.file,
            explanation:
              `${a.agent_id} adds an early-return/guard to ${changeA.name}'s body while ${b.agent_id} ` +
              `appends code assumed to run unconditionally after it. Composed, B's code may become dead ` +
              `on the path A now short-circuits. HEURISTIC (tag-based body diffing) — confirm by reading ` +
              `both diffs; this detector does not parse control flow.`,
            passes_textual_merge: true,
            evidence: [
              `body_tag:${a.agent_id}:early-return-or-guard`,
              `body_tag:${b.agent_id}:appends-after`,
            ],
          });
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Detector 5: invariant-conflict (OPTIONAL, AI-flavored, off by default)
// ---------------------------------------------------------------------------

/**
 * A's intent asserts an invariant ("idempotent"/"immutable"/"non-null" etc.);
 * B's change to the same symbol plausibly violates it (heuristically: B
 * touches the same symbol's body/nullability/signature without asserting
 * the same invariant). Requires an InvariantInterpreter; with none supplied
 * this detector returns [] and contributes nothing — the four deterministic
 * detectors above are entirely unaffected by its absence.
 */
function detectInvariantConflicts(
  states: AgentInFlightState[],
  interpreter?: InvariantInterpreter
): ConceptualConflict[] {
  if (!interpreter) return [];
  const findings: ConceptualConflict[] = [];
  const seen = new Set<string>();

  for (const agentA of states) {
    for (const changeA of agentA.changes) {
      const assertions = interpreter(agentA.intent, changeA.name) ?? [];
      if (assertions.length === 0) continue;

      for (const agentB of states) {
        if (agentB.agent_id === agentA.agent_id) continue;
        for (const changeB of agentB.changes) {
          if (changeB.symbol_id !== changeA.symbol_id) continue;
          const bAssertsSame = (interpreter(agentB.intent, changeB.name) ?? []).some((x) =>
            assertions.some((y) => y.invariant === x.invariant)
          );
          if (bAssertsSame) continue; // B explicitly upholds it too — not a conflict

          for (const assertion of assertions) {
            const key = pairKey(agentA.agent_id, agentB.agent_id) + '|' + changeA.symbol_id + '|' + assertion.invariant;
            if (seen.has(key)) continue;
            seen.add(key);
            findings.push({
              kind: 'invariant-conflict',
              severity: 'medium',
              agents: [agentA.agent_id, agentB.agent_id],
              symbol: changeA.symbol_id,
              symbol_ids: [changeA.symbol_id, changeB.symbol_id],
              file: changeA.file,
              explanation:
                `${agentA.agent_id}'s intent asserts ${changeA.name} is now "${assertion.invariant}", ` +
                `but ${agentB.agent_id} concurrently changes the same symbol without upholding that ` +
                `invariant. AI-interpreted (intent-level), not structurally verified.`,
              passes_textual_merge: true,
              evidence: [`invariant_assertion:${assertion.invariant}`, `concurrent_change:${changeB.symbol_id}`],
            });
          }
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface DetectConceptualConflictsOptions {
  /** Optional AI-flavored invariant interpreter (detector 5). Omit to keep
   *  the detector suite 100% deterministic. */
  invariantInterpreter?: InvariantInterpreter;
}

/**
 * Detect conceptual conflicts among concurrently in-flight agent states,
 * using the CAS call graph for detector 1 (contract-divergence). Pure and
 * deterministic by default (detectors 1-4); detector 5 is optional AI flavor
 * and no-ops without an interpreter.
 */
export function detectConceptualConflicts(
  states: AgentInFlightState[],
  cas: ConflictCas,
  options: DetectConceptualConflictsOptions = {}
): ConceptualConflict[] {
  return [
    ...detectContractDivergence(states, cas),
    ...detectDuplicateWork(states),
    ...detectStructuralDivergence(states),
    ...detectBehaviorDrift(states),
    ...detectInvariantConflicts(states, options.invariantInterpreter),
  ];
}
