/**
 * Intent-aware merge (Fabric-v2 #1, §1.7 SPEC-COORDINATION-FABRIC-V2 primitive
 * 5, "the art of merge"): when agents finish editing the same or related
 * code, reconcile by INTENT rather than by textual 3-way diff.
 *
 * Git (and any textual merge tool) answers one question: do the lines
 * overlap? If not, it merges silently — even when the two changes are
 * jointly incoherent (see conceptual-conflict.ts's whole reason for being).
 * If they DO overlap, git conflicts mechanically, with zero understanding of
 * whether the two edits are actually compatible in intent (e.g. one agent
 * adding retry and another adding logging to the same function body are
 * almost always compatible — orthogonal, additive, composable — yet a
 * textual merge on the same lines would still throw a conflict marker at a
 * human).
 *
 * This module sits on top of the SAME AgentInFlightState[]/CAS the
 * conceptual-conflict detector consumes and answers a different, higher-level
 * question: for each symbol touched by the fleet, do the changes COHERE?
 *
 *   - Multiple agents, no conceptual conflict          -> auto_mergeable
 *     (compatible intents that compose; includes the trivial single-agent
 *     case, since one agent editing a symbol nobody else touched always
 *     "merges" with nothing).
 *   - Multiple agents, conceptual conflict detected     -> needs_resolution
 *     (genuinely incoherent; a human or agent must decide — never silently
 *     auto-merged, even though it would pass a textual merge cleanly).
 *   - Multiple agents, duplicate-work conflict detected -> duplicate_work
 *     (same thing done twice; keep one, don't compose two copies).
 *
 * Pure module: no IO. Imports AgentInFlightState/SymbolChange/
 * detectConceptualConflicts from conceptual-conflict.ts rather than
 * redefining them, so this is a thin reasoning layer over the existing
 * detector, not a parallel implementation.
 *
 * W4 STEP 1 (docs/SPEC-COORDINATION-FABRIC-V3.md §8 W4, "re-base on W0, then
 * push from reconcile-at-the-end to never-diverge"): §3.2 proved the ORIGINAL
 * capture path here — git-ambient / self-reported `AgentInFlightState[]` — is
 * UNSOUND once more than one participant is on a shared tree ("every
 * participant's own diff is the union of everyone's"; this module's own "0
 * conflicts" verdict was correct by luck, not reasoning). `planIntentMerge`
 * itself (the pure reasoning core below — groupBySymbol + conflict
 * classification) is UNCHANGED and still correct GIVEN a sound
 * `AgentInFlightState[]` input; what changes is where that input comes from:
 *
 *   - `planIntentMerge` (unchanged): takes `AgentInFlightState[]` from
 *     WHEREVER the caller got it. Still the right function for a
 *     single-participant workspace, or a caller that already has a sound
 *     per-participant state list some other way — see `shouldUseSubstratePlan`.
 *   - `planIntentMergeFromSubstrate` (NEW): builds that same input from
 *     `getAttributedInFlightState` (in-flight-substrate.ts, W0) instead of
 *     ambient git diff — per-participant deltas attributed to active CLAIM
 *     SCOPE, with the write-hook's announced-edit/unclaimed-edit event log
 *     as a tiebreaker for anything a claim doesn't cover (W4 step 1's second
 *     attribution source). Symbols neither claim-attributed nor
 *     tiebreak-resolved are reported as an explicit, honest `unattributed`
 *     bucket on the returned plan — NEVER guessed, NEVER silently folded
 *     into whichever agent happens to be asking.
 *
 * Both paths also now compute the V3 §5/§9 MERGELESS METRICS
 * (`merge_decisions_required`, `surprises`) on every `MergePlan` — see
 * `computeMergelessMetrics` below. This step does not attempt full
 * continuous reconciliation (that is later W4 work); it is "sound
 * attribution + honest metrics," which is what makes driving those metrics
 * to 0 possible in the first place.
 */

import {
  detectConceptualConflicts,
  type AgentInFlightState,
  type ConceptualConflict,
  type ConflictCas,
  type DetectConceptualConflictsOptions,
  type SymbolChange,
  type SymbolChangeKind,
} from './conceptual-conflict';
import { getAttributedInFlightState } from './in-flight-substrate';
import { persistSurprise } from './local-store';

export interface AutoMergeableEntry {
  symbol: string;
  agents: string[];
  rationale: string;
}

export interface NeedsResolutionEntry {
  symbol: string;
  agents: string[];
  conflict: ConceptualConflict;
}

export interface DuplicateWorkEntry {
  symbol: string;
  agents: string[];
}

export interface MergePlanSummary {
  total_symbols: number;
  auto: number;
  conflicts: number;
  duplicates: number;
}

/**
 * A "surprise" (V3 §5/§9): a change that implies a PARTICIPANT hasn't seen
 * something relevant yet — specifically, a `contract-divergence` finding
 * (one agent changed a symbol's contract; another agent's in-flight code
 * calls/depends on it) that `passes_textual_merge`. Textual merge would land
 * this silently; the participant would first learn of it at merge time,
 * which is exactly the surprise the mergeless metric (§9: "surprise rate ->
 * 0") measures. Reuses `detectConceptualConflicts`'s own contract-divergence
 * detector rather than a parallel heuristic — cheap, since `needs_resolution`
 * already carries every conflict this symbol produced.
 */
export interface SurpriseEntry {
  symbol: string;
  agents: string[];
  explanation: string;
}

/**
 * Push each computed surprise into the claim log, addressed to the AFFECTED
 * participant (W4 step 2: "kills learn-at-merge-time" — see
 * `local-store.ts persistSurprise`). `contract-divergence` findings always
 * carry `agents` as `[changer, affected]` (the detector's own construction —
 * `detectContractDivergence` pushes `[agentA.agent_id, agentB.agent_id]`
 * where A changed the contract and B is the caller-editor who'd be surprised
 * at merge time); a malformed entry with fewer than 2 agents is skipped
 * rather than guessed. Best-effort and non-fatal: a storage hiccup here must
 * never fail the merge-plan call itself, since the CALLER already has the
 * metrics in `surprises[]` regardless of whether persistence succeeds.
 */
async function pushSurprisesToLog(workspace: string, surprises: SurpriseEntry[]): Promise<void> {
  await Promise.all(
    surprises.map(async (s) => {
      const [changer, affected] = s.agents;
      if (!changer || !affected) return; // malformed — never guess who's affected.
      try {
        await persistSurprise(workspace, { symbol: s.symbol, changer, affected, explanation: s.explanation });
      } catch {
        // best-effort ambient delivery; the caller already has surprises[] from the returned plan.
      }
    })
  );
}

export interface MergePlan {
  auto_mergeable: AutoMergeableEntry[];
  needs_resolution: NeedsResolutionEntry[];
  duplicate_work: DuplicateWorkEntry[];
  summary: MergePlanSummary;
  /**
   * THE V3 metrics (§5 "mergeless", §9 acceptance metrics) — measuring these
   * is step 1 of driving them to 0, not a claim that they already are 0.
   */
  merge_decisions_required: number;
  surprises: SurpriseEntry[];
}

/** Compute the V3 mergeless metrics from an already-classified plan (pure — no IO). */
function computeMergelessMetrics(
  needs_resolution: NeedsResolutionEntry[],
  duplicate_work: DuplicateWorkEntry[]
): { merge_decisions_required: number; surprises: SurpriseEntry[] } {
  // Every needs_resolution AND duplicate_work entry is, by construction, a
  // genuine cross-participant decision a human/agent must make (§5: "merge
  // decisions" are exactly the questions git's silent/mechanical merge can't
  // answer) — auto_mergeable entries are explicitly NOT decisions (that's
  // the whole point of the bucket).
  const merge_decisions_required = needs_resolution.length + duplicate_work.length;
  const surprises: SurpriseEntry[] = needs_resolution
    .filter((e) => e.conflict.kind === 'contract-divergence' && e.conflict.passes_textual_merge)
    .map((e) => ({ symbol: e.symbol, agents: e.agents, explanation: e.conflict.explanation }));
  return { merge_decisions_required, surprises };
}

export interface PlanIntentMergeOptions extends DetectConceptualConflictsOptions {}

// ---------------------------------------------------------------------------
// Grouping: every symbol touched by the fleet, with each agent's change to it.
// ---------------------------------------------------------------------------

interface SymbolGroup {
  symbol: string;
  file?: string;
  entries: Array<{ agent_id: string; intent: string; change: SymbolChange }>;
}

function groupBySymbol(states: AgentInFlightState[]): Map<string, SymbolGroup> {
  const groups = new Map<string, SymbolGroup>();
  for (const state of states) {
    for (const change of state.changes) {
      let group = groups.get(change.symbol_id);
      if (!group) {
        group = { symbol: change.symbol_id, file: change.file, entries: [] };
        groups.set(change.symbol_id, group);
      }
      group.entries.push({ agent_id: state.agent_id, intent: state.intent, change });
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Compose-vs-conflict reasoning for the no-conceptual-conflict case.
// ---------------------------------------------------------------------------

/** Change kinds that are inherently additive/orthogonal-friendly: they extend
 *  behavior without redefining an existing contract or structure. */
const ADDITIVE_KINDS = new Set<SymbolChangeKind>(['add', 'body']);

/** Change kinds that redefine the symbol's shape — two agents both touching
 *  one of these on the SAME symbol are editing the same concern, not
 *  orthogonal concerns, even absent a detected conceptual conflict. */
const SHAPE_KINDS = new Set<SymbolChangeKind>(['signature', 'return_type', 'nullability', 'param', 'rename', 'split', 'move', 'delete']);

/**
 * Build a human-readable rationale for why a symbol's multi-agent changes
 * compose cleanly, naming both intents. Falls back to a generic "no
 * conceptual conflict detected" framing when the changes aren't a clean
 * textbook orthogonal-additive case (still auto-mergeable — the conceptual
 * detector found nothing incoherent — but the rationale is honest about not
 * having a sharper story).
 */
function rationaleFor(group: SymbolGroup): string {
  const { entries } = group;
  if (entries.length === 1) {
    return `Only ${entries[0].agent_id} touched ${group.symbol} — nothing to reconcile.`;
  }

  const agentNames = entries.map((e) => e.agent_id);
  const allAdditive = entries.every((e) => ADDITIVE_KINDS.has(e.change.change_kind));
  const anyShapeKind = entries.some((e) => SHAPE_KINDS.has(e.change.change_kind));

  if (allAdditive && entries.length === 2) {
    const [a, b] = entries;
    return (
      `${a.agent_id} ("${a.intent}") and ${b.agent_id} ("${b.intent}") both make additive, ` +
      `non-contract-changing edits to ${group.symbol} — orthogonal concerns that compose cleanly ` +
      `(neither redefines the other's contract or structure).`
    );
  }

  if (allAdditive) {
    return (
      `${agentNames.join(', ')} all make additive, non-contract-changing edits to ${group.symbol} ` +
      `with no detected conceptual conflict — orthogonal concerns that compose.`
    );
  }

  if (anyShapeKind) {
    // A shape-changing edit exists but the conceptual detector found no
    // divergence (e.g. only one agent touches the shape; others are additive
    // and don't call it in an incompatible way, or the CAS shows no caller
    // overlap). Still coherent — just not the purely-additive textbook case.
    return (
      `${agentNames.join(', ')} touch ${group.symbol} (including a shape-changing edit) but no ` +
      `conceptual conflict was detected between their intents — the changes are compatible as-is.`
    );
  }

  return (
    `${agentNames.join(', ')} touch ${group.symbol} with no detected conceptual conflict — ` +
    `intents compose cleanly.`
  );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Reconcile concurrently in-flight agent states by INTENT rather than by
 * textual diff. Consumes the same `AgentInFlightState[]` + CAS shape the
 * conceptual-conflict detector uses; does not redefine or duplicate that
 * detector's logic — it classifies each touched symbol using the detector's
 * output plus additive/orthogonality reasoning over `change_kind`.
 *
 * Precedence per symbol (a symbol can only land in ONE bucket):
 *   1. duplicate-work conflict detected      -> duplicate_work
 *   2. any other conceptual conflict detected -> needs_resolution
 *   3. otherwise                              -> auto_mergeable
 *      (covers both the "genuinely orthogonal, multi-agent" case and the
 *      trivial "only one agent touched it" case)
 */
export function planIntentMerge(
  states: AgentInFlightState[],
  cas: ConflictCas,
  options: PlanIntentMergeOptions = {}
): MergePlan {
  const groups = groupBySymbol(states);
  const allConflicts = detectConceptualConflicts(states, cas, options);

  // Index conflicts by symbol, split into duplicate-work vs. everything else.
  const duplicateConflictsBySymbol = new Map<string, ConceptualConflict>();
  const otherConflictsBySymbol = new Map<string, ConceptualConflict>();
  for (const conflict of allConflicts) {
    // A conflict's `.symbol` field only names ONE side of the pair (e.g.
    // duplicate-work's `bothAdd` case has two distinct symbol_ids for the same
    // logical name — the detector records changeA's symbol_id and drops
    // changeB's). Index by every symbol_id this conflict's OWN group touches
    // instead of trusting `.symbol` alone: the primary group (matched by
    // symbol_id), plus any group that (a) is touched by exactly this
    // conflict's agent set and (b) shares the conflicting change's `name`
    // with the primary group — the same correlation the detector itself used
    // (bothAdd requires changeA.name === changeB.name) to find the pair in
    // the first place.
    const primaryGroup = groups.get(conflict.symbol);
    const symbolIds = new Set<string>([conflict.symbol]);
    if (primaryGroup) {
      const primaryNames = new Set(primaryGroup.entries.map((e) => e.change.name));
      const conflictAgentSet = new Set(conflict.agents);
      for (const group of groups.values()) {
        if (symbolIds.has(group.symbol)) continue;
        const groupAgentIds = new Set(group.entries.map((e) => e.agent_id));
        // The other group's agent(s) must all be part of THIS conflict's
        // agent set (subset, not exact-equality — a group can be
        // single-agent while the conflict spans a pair).
        const agentsWithinConflict = [...groupAgentIds].every((a) => conflictAgentSet.has(a));
        if (!agentsWithinConflict || groupAgentIds.size === 0) continue;
        const sharesName = group.entries.some((e) => primaryNames.has(e.change.name));
        if (sharesName) symbolIds.add(group.symbol);
      }
    }

    for (const symbolId of symbolIds) {
      if (conflict.kind === 'duplicate-work') {
        if (!duplicateConflictsBySymbol.has(symbolId)) duplicateConflictsBySymbol.set(symbolId, conflict);
      } else {
        if (!otherConflictsBySymbol.has(symbolId)) otherConflictsBySymbol.set(symbolId, conflict);
      }
    }
  }

  const auto_mergeable: AutoMergeableEntry[] = [];
  const needs_resolution: NeedsResolutionEntry[] = [];
  const duplicate_work: DuplicateWorkEntry[] = [];

  for (const group of groups.values()) {
    const agents = [...new Set(group.entries.map((e) => e.agent_id))];
    const dup = duplicateConflictsBySymbol.get(group.symbol);
    const other = otherConflictsBySymbol.get(group.symbol);

    if (dup) {
      duplicate_work.push({ symbol: group.symbol, agents: [...new Set(dup.agents)] });
      continue;
    }
    if (other) {
      needs_resolution.push({ symbol: group.symbol, agents: [...new Set(other.agents)], conflict: other });
      continue;
    }
    auto_mergeable.push({ symbol: group.symbol, agents, rationale: rationaleFor(group) });
  }

  const { merge_decisions_required, surprises } = computeMergelessMetrics(needs_resolution, duplicate_work);

  return {
    auto_mergeable,
    needs_resolution,
    duplicate_work,
    summary: {
      total_symbols: groups.size,
      auto: auto_mergeable.length,
      conflicts: needs_resolution.length,
      duplicates: duplicate_work.length,
    },
    merge_decisions_required,
    surprises,
  };
}

// ---------------------------------------------------------------------------
// Substrate-based path (W4 step 1) — re-based on the W0 attributed substrate
// ---------------------------------------------------------------------------

export interface MergeAttributionInfo {
  /** 'substrate' = built from getAttributedInFlightState (claim-scope + write-hook tiebreaker),
   *  never ambient git diff. 'git-ambient' = the pre-W4 capture path (sound only at <=1 participant). */
  source: 'substrate' | 'git-ambient';
  /** Participants whose delta was attributed via an active claim's scope. */
  participants: number;
  /** Deltas resolved via the write-hook's announced-edit/unclaimed-edit event log tiebreaker
   *  (no active claim covered them, but the event log named exactly one agent). */
  tiebroken: number;
  /** Deltas that could be attributed to neither an active claim nor the write-hook tiebreaker —
   *  reported honestly, never guessed, never silently folded into whoever is asking. */
  unattributed: number;
}

export interface UnattributedMergeSymbol {
  symbol_id: string;
  name: string;
  file?: string;
  reason: string;
}

export interface SubstrateMergePlan extends MergePlan {
  attribution: MergeAttributionInfo;
  /** The honest "we don't know whose this is" bucket — separate from `needs_resolution` (a KNOWN
   *  cross-participant conflict) because these symbols were never attributed to any participant at
   *  all, so there is no "who" to resolve a decision between yet. */
  unattributed_symbols: UnattributedMergeSymbol[];
}

/**
 * Selection rule (documented on the `plan_intent_merge` tool description in
 * server.ts too): the git-ambient capture path is sound ONLY when at most one
 * participant is active on the workspace (§3.2 — attribution collapses the
 * moment a second participant's edits land on the same tree). Pass an
 * explicit `explicitUseSubstrate` to override (true forces substrate even for
 * a single participant, e.g. to dogfood/verify it; false forces git-ambient,
 * e.g. a caller that already validated single-participant-ness itself).
 * Omitted (undefined) auto-selects from the live active-participant count.
 */
export function shouldUseSubstratePlan(
  activeParticipantCount: number,
  explicitUseSubstrate?: boolean
): boolean {
  if (explicitUseSubstrate !== undefined) return explicitUseSubstrate;
  return activeParticipantCount > 1;
}

/**
 * Build a `MergePlan` from the W0 substrate (`getAttributedInFlightState`)
 * instead of ambient git diff / self-reported state. Per-participant
 * `AgentInFlightState`s come from claim-scope attribution PLUS the
 * write-hook's event-log tiebreaker for anything a claim didn't cover;
 * symbols resolved by neither are surfaced in `unattributed_symbols`,
 * honestly, never guessed. `planIntentMerge` itself (the classification core)
 * is reused UNCHANGED — this function only sources its input differently.
 */
export async function planIntentMergeFromSubstrate(
  workspace: string,
  cas: ConflictCas,
  options: PlanIntentMergeOptions = {}
): Promise<SubstrateMergePlan> {
  const attributed = await getAttributedInFlightState(workspace);

  // Fold both attribution sources into one AgentInFlightState per agent_id:
  // claim-attributed changes (participants) plus write-hook-tiebroken changes
  // for agents a claim didn't cover (or whose claim has since expired) — an
  // agent can appear in both sources at once (e.g. still holds the claim AND
  // has an older tiebroken edit outside its current scope).
  const changesByAgent = new Map<string, { intent: string; changes: SymbolChange[] }>();
  for (const p of attributed.participants) {
    if (p.delta.changes.length === 0) continue;
    const entry = changesByAgent.get(p.agent_id) ?? { intent: p.intent, changes: [] };
    entry.changes.push(...p.delta.changes);
    changesByAgent.set(p.agent_id, entry);
  }
  for (const t of attributed.tiebroken) {
    const entry = changesByAgent.get(t.agent_id) ?? { intent: `write-hook tiebreak (${t.via})`, changes: [] };
    entry.changes.push(t.change);
    changesByAgent.set(t.agent_id, entry);
  }

  const states: AgentInFlightState[] = [...changesByAgent.entries()].map(([agent_id, e]) => ({
    agent_id,
    intent: e.intent,
    changes: e.changes,
  }));

  const plan = planIntentMerge(states, cas, options);

  // W4 step 2: persist each surprise to the claim log, addressed to the
  // affected participant — see `pushSurprisesToLog`. Only meaningful on the
  // substrate path (this function), since `planIntentMerge` itself stays a
  // pure, IO-free function per this module's own contract.
  await pushSurprisesToLog(workspace, plan.surprises);

  return {
    ...plan,
    attribution: {
      source: 'substrate',
      participants: attributed.participants.length,
      tiebroken: attributed.tiebroken.length,
      unattributed: attributed.unattributed.length,
    },
    unattributed_symbols: attributed.unattributed.map((u) => ({
      symbol_id: u.symbol_id,
      name: u.name,
      file: u.file,
      reason: u.reason,
    })),
  };
}

export type { AgentInFlightState, ConceptualConflict, ConflictCas, SymbolChange };

/** Re-exported so callers of the merge-plan surface don't need a second
 *  import from local-store.ts just to read back what `planIntentMergeFromSubstrate`
 *  persisted — see `local-store.ts` for the read-side implementation. */
export { persistSurprise, readSurprisesFor, type SurpriseDetail } from './local-store';
