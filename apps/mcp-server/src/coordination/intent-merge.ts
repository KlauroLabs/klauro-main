




























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
import { getMergelessMetrics, recordMergelessObservation, type MergelessMetrics } from './mergeless-metrics';
import { readParticipantInFlightSnapshots } from './participant-in-flight-store';
import { recordFabricDeliveryStage } from './fabric-delivery-metrics';

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












export interface SurpriseEntry {
  symbol: string;
  agents: string[];
  explanation: string;
}













async function pushSurprisesToLog(workspace: string, surprises: SurpriseEntry[]): Promise<void> {
  await Promise.all(
    surprises.map(async (s) => {
      const [changer, affected] = s.agents;
      if (!changer || !affected) return;
      try {
        await persistSurprise(workspace, { symbol: s.symbol, changer, affected, explanation: s.explanation });
      } catch {

      }
    })
  );
}

export interface MergePlan {
  auto_mergeable: AutoMergeableEntry[];
  needs_resolution: NeedsResolutionEntry[];
  duplicate_work: DuplicateWorkEntry[];
  summary: MergePlanSummary;




  merge_decisions_required: number;
  surprises: SurpriseEntry[];
}


function computeMergelessMetrics(
  needs_resolution: NeedsResolutionEntry[],
  duplicate_work: DuplicateWorkEntry[]
): { merge_decisions_required: number; surprises: SurpriseEntry[] } {





  const merge_decisions_required = needs_resolution.length + duplicate_work.length;
  const surprises: SurpriseEntry[] = needs_resolution
    .filter((e) => e.conflict.kind === 'contract-divergence' && e.conflict.passes_textual_merge)
    .map((e) => ({ symbol: e.symbol, agents: e.agents, explanation: e.conflict.explanation }));
  return { merge_decisions_required, surprises };
}

export interface PlanIntentMergeOptions extends DetectConceptualConflictsOptions {}





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







const ADDITIVE_KINDS = new Set<SymbolChangeKind>(['add', 'body']);




const SHAPE_KINDS = new Set<SymbolChangeKind>(['signature', 'return_type', 'nullability', 'param', 'rename', 'split', 'move', 'delete']);









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



















export function planIntentMerge(
  states: AgentInFlightState[],
  cas: ConflictCas,
  options: PlanIntentMergeOptions = {}
): MergePlan {
  const groups = groupBySymbol(states);
  const allConflicts = detectConceptualConflicts(states, cas, options);


  const duplicateConflictsBySymbol = new Map<string, ConceptualConflict>();
  const otherConflictsBySymbol = new Map<string, ConceptualConflict>();
  for (const conflict of allConflicts) {










    const primaryGroup = groups.get(conflict.symbol);
    const symbolIds = new Set<string>([conflict.symbol]);
    if (primaryGroup) {
      const primaryNames = new Set(primaryGroup.entries.map((e) => e.change.name));
      const conflictAgentSet = new Set(conflict.agents);
      for (const group of groups.values()) {
        if (symbolIds.has(group.symbol)) continue;
        const groupAgentIds = new Set(group.entries.map((e) => e.agent_id));



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





export interface MergeAttributionInfo {
  source: 'participant-semantic-streams' | 'workspace-semantic-fallback';

  participants: number;


  tiebroken: number;


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



  unattributed_symbols: UnattributedMergeSymbol[];
  mergeless_metrics: MergelessMetrics;
}











export function shouldUseSubstratePlan(
  _activeParticipantCount: number,
  explicitUseSubstrate?: boolean
): boolean {
  if (explicitUseSubstrate !== undefined) return explicitUseSubstrate;
  return true;
}










export async function planIntentMergeFromSubstrate(
  workspace: string,
  cas: ConflictCas,
  options: PlanIntentMergeOptions = {}
): Promise<SubstrateMergePlan> {
  const attributed = await getAttributedInFlightState(workspace);






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





  await pushSurprisesToLog(workspace, plan.surprises);
  const reconciledAt = new Date().toISOString();
  if (attributed.participants.length + attributed.tiebroken.length + attributed.unattributed.length > 0) {
    await recordMergelessObservation({
      workspace,
      observed_at: reconciledAt,
      attribution_source: attributed.attribution_source,
      participant_count: attributed.participants.length + attributed.tiebroken.length,
      changed_symbol_count: plan.summary.total_symbols,
      merge_decisions_required: plan.merge_decisions_required,
      surprise_count: plan.surprises.length,
      unattributed_count: attributed.unattributed.length,
    });
  }
  const snapshots = await readParticipantInFlightSnapshots(workspace);
  for (const snapshot of snapshots) {
    if (!snapshot.operation_id) continue;
    await recordFabricDeliveryStage({
      workspace,
      operation_id: snapshot.operation_id,
      operation_kind: 'in-flight',
      participant_id: snapshot.agent_id,
      captured_at: snapshot.captured_at,
      client_persisted_at: snapshot.client_persisted_at,
      acknowledged_at: snapshot.server_persisted_at ?? snapshot.updated_at,
      reconciled_at: reconciledAt,
      delivery_attempt: snapshot.delivery_attempt,
      source_identity: snapshot.source_identity,
    });
  }
  const mergelessMetrics = await getMergelessMetrics(workspace);

  return {
    ...plan,
    attribution: {
      source: attributed.attribution_source,
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
    mergeless_metrics: mergelessMetrics,
  };
}

export type { AgentInFlightState, ConceptualConflict, ConflictCas, SymbolChange };




export { persistSurprise, readSurprisesFor, type SurpriseDetail } from './local-store';
