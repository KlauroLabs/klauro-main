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

export interface MergePlan {
  auto_mergeable: AutoMergeableEntry[];
  needs_resolution: NeedsResolutionEntry[];
  duplicate_work: DuplicateWorkEntry[];
  summary: MergePlanSummary;
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
  };
}

export type { AgentInFlightState, ConceptualConflict, ConflictCas, SymbolChange };
