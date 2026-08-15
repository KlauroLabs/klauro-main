




























import type { CASNode, CASOutput } from '../../../../packages/analyzer-core/src/types/cas.types';
import { loadAnalysis } from '../storage';
import { getActiveClaims, readClaimLog, type ClaimLogEntry } from './local-store';
import { readParticipantInFlightSnapshots, type ParticipantInFlightSnapshot } from './participant-in-flight-store';
import type { WorkClaim } from './types';
import {
  detectConceptualConflicts,
  type AgentInFlightState,
  type ConceptualConflict,
  type ConflictCas,
  type DetectConceptualConflictsOptions,
  type SymbolChange,
  type SymbolChangeKind,
  type SymbolChangeShape,
} from './conceptual-conflict';





export type SemanticSymbolDeltaKind = 'added' | 'removed' | 'changed';

export interface SemanticSymbolDelta {
  symbol_id: string;
  name: string;
  file?: string;
  type?: string;
  kind: SemanticSymbolDeltaKind;

  fields_changed?: string[];
}

export interface EntryPointDelta {
  id: string;
  name: string;
  kind: 'added' | 'removed' | 'touched';
}

export interface FlowTouch {
  id: string;
  name?: string;
  criticality?: string;
}

export interface CapabilityTouch {
  id: string;
  name: string;
}

export interface InFlightSemanticDelta {
  workspace: string;
  participant_id: string;

  available: boolean;
  reason?: string;
  main_present: boolean;
  inflight_present: boolean;
  symbols: SemanticSymbolDelta[];
  entry_points: EntryPointDelta[];
  flows_touched: FlowTouch[];
  capabilities_touched: CapabilityTouch[];






  changes: SymbolChange[];
}





function nodeSignatureString(node: CASNode): string | undefined {
  const sig = node.signature;
  if (!sig) return undefined;
  const params = (sig.parameters || [])
    .map((p: { name: string; type?: string; optional?: boolean; default_value?: string }) =>
      `${p.name}${p.optional ? '?' : ''}:${p.type ?? 'any'}${p.default_value !== undefined ? `=${p.default_value}` : ''}`)
    .join(', ');
  return `(${params})${sig.return_type ? `: ${sig.return_type}` : ''}`;
}


function nodeReturnNullable(node: CASNode): boolean | undefined {
  const rt = node.signature?.return_type;
  if (rt === undefined) return undefined;
  return /\bnull\b|\bundefined\b/.test(rt) || /\?\s*$/.test(rt);
}

function nodeToShape(node: CASNode): SymbolChangeShape {
  return {
    signature: nodeSignatureString(node),
    return_type: node.signature?.return_type,
    nullable: nodeReturnNullable(node),
    name: node.name,
  };
}









function diffNodes(mainNodes: CASNode[], inflightNodes: CASNode[]): SemanticSymbolDelta[] {
  const mainById = new Map(mainNodes.map((n) => [n.id, n]));
  const inflightById = new Map(inflightNodes.map((n) => [n.id, n]));
  const deltas: SemanticSymbolDelta[] = [];

  for (const node of inflightNodes) {
    if (!mainById.has(node.id)) {
      deltas.push({ symbol_id: node.id, name: node.name, file: node.source?.file, type: node.type, kind: 'added' });
    }
  }
  for (const node of mainNodes) {
    if (!inflightById.has(node.id)) {
      deltas.push({ symbol_id: node.id, name: node.name, file: node.source?.file, type: node.type, kind: 'removed' });
    }
  }
  for (const node of inflightNodes) {
    const prev = mainById.get(node.id);
    if (!prev) continue;
    const fields: string[] = [];
    if (JSON.stringify(prev.signature) !== JSON.stringify(node.signature)) fields.push('signature');
    if (prev.signature?.return_type !== node.signature?.return_type) fields.push('return_type');
    if (nodeReturnNullable(prev) !== nodeReturnNullable(node)) fields.push('nullability');
    if (JSON.stringify(prev.metadata) !== JSON.stringify(node.metadata)) fields.push('metadata');
    if (prev.source?.line !== node.source?.line) fields.push('location');
    if (fields.length > 0) {
      deltas.push({
        symbol_id: node.id,
        name: node.name,
        file: node.source?.file,
        type: node.type,
        kind: 'changed',
        fields_changed: fields,
      });
    }
  }
  return deltas;
}

function diffEntryPoints(
  mainEntryPoints: Array<{ id: string; name: string }>,
  inflightEntryPoints: Array<{ id: string; name: string }>
): EntryPointDelta[] {
  const mainIds = new Set(mainEntryPoints.map((e) => e.id));
  const inflightIds = new Set(inflightEntryPoints.map((e) => e.id));
  const deltas: EntryPointDelta[] = [];
  for (const ep of inflightEntryPoints) {
    if (!mainIds.has(ep.id)) deltas.push({ id: ep.id, name: ep.name, kind: 'added' });
  }
  for (const ep of mainEntryPoints) {
    if (!inflightIds.has(ep.id)) deltas.push({ id: ep.id, name: ep.name, kind: 'removed' });
  }
  return deltas;
}

function symbolChangeKindFor(delta: SemanticSymbolDelta): SymbolChangeKind {
  if (delta.kind === 'added') return 'add';
  if (delta.kind === 'removed') return 'delete';
  const fields = delta.fields_changed || [];
  if (fields.includes('return_type')) return 'return_type';
  if (fields.includes('nullability')) return 'nullability';
  if (fields.includes('signature')) return 'signature';
  return 'body';
}

function toSymbolChange(
  delta: SemanticSymbolDelta,
  mainNode: CASNode | undefined,
  inflightNode: CASNode | undefined
): SymbolChange {
  return {
    symbol_id: delta.symbol_id,
    name: delta.name,
    file: delta.file ?? mainNode?.source?.file ?? inflightNode?.source?.file ?? 'unknown',
    change_kind: symbolChangeKindFor(delta),
    before: mainNode ? nodeToShape(mainNode) : undefined,
    after: inflightNode ? nodeToShape(inflightNode) : undefined,
  };
}

function flowsTouchedBy(cas: CASOutput | null, changedNodeIds: Set<string>): FlowTouch[] {
  if (!cas?.call_chains) return [];
  const touched: FlowTouch[] = [];
  for (const chain of cas.call_chains) {
    const hits = chain.call_path.some((step) => changedNodeIds.has(step.node_id));
    if (!hits) continue;
    touched.push({
      id: chain.id,
      name: chain.business_context?.business_process || chain.business_context?.feature_area || chain.entry_point?.method_name,
      criticality: chain.criticality,
    });
  }
  return touched;
}

function capabilitiesTouchedBy(cas: CASOutput | null, changedEntryPointIds: Set<string>): CapabilityTouch[] {
  if (!cas?.capabilities) return [];
  const touched: CapabilityTouch[] = [];
  for (const cap of cas.capabilities) {
    const hits = (cap.operations || []).some((op) => changedEntryPointIds.has(op.entry_point_id));
    if (hits) touched.push({ id: cap.id, name: cap.name });
  }
  return touched;
}













export async function getInFlightSemanticDelta(
  workspacePath: string,
  participantId: string
): Promise<InFlightSemanticDelta> {
  const [mainCas, inflightCas] = await Promise.all([
    loadAnalysis(workspacePath, { preferCache: true, track: 'main' }).catch(() => null),
    loadAnalysis(workspacePath, { preferCache: true, track: 'in-flight' }).catch(() => null),
  ]);

  const mainPresent = Boolean(mainCas);

  if (!inflightCas) {
    return {
      workspace: workspacePath,
      participant_id: participantId,
      available: false,
      reason: mainPresent
        ? 'no in-flight (dirty working tree) analysis found for this project — the tree may be clean, or nobody has re-analyzed while it was dirty; nothing to attribute yet (W0 has no substrate until an in-flight snapshot exists)'
        : 'no analysis found for this project at all (neither main nor in-flight) — run analyze_codebase first',
      main_present: mainPresent,
      inflight_present: false,
      symbols: [],
      entry_points: [],
      flows_touched: [],
      capabilities_touched: [],
      changes: [],
    };
  }

  const mainNodes = mainCas?.nodes ?? [];
  const inflightNodes = inflightCas.nodes ?? [];
  const mainEntryPoints = (mainCas?.entry_points ?? []).map((e) => ({ id: e.id, name: e.name }));
  const inflightEntryPoints = (inflightCas.entry_points ?? []).map((e) => ({ id: e.id, name: e.name }));

  const symbols = diffNodes(mainNodes, inflightNodes);
  const entryPoints = diffEntryPoints(mainEntryPoints, inflightEntryPoints);

  const mainById = new Map(mainNodes.map((n) => [n.id, n]));
  const inflightById = new Map(inflightNodes.map((n) => [n.id, n]));
  const changes = symbols.map((delta) => toSymbolChange(delta, mainById.get(delta.symbol_id), inflightById.get(delta.symbol_id)));

  const changedNodeIds = new Set(symbols.map((s) => s.symbol_id));
  const changedEntryPointIds = new Set(entryPoints.map((e) => e.id));

  return {
    workspace: workspacePath,
    participant_id: participantId,
    available: true,
    main_present: mainPresent,
    inflight_present: true,
    symbols,
    entry_points: entryPoints,
    flows_touched: flowsTouchedBy(inflightCas, changedNodeIds),
    capabilities_touched: capabilitiesTouchedBy(inflightCas, changedEntryPointIds),
    changes,
  };
}





export interface UnattributedSymbolDelta extends SemanticSymbolDelta {





  reason: 'unclaimed' | 'overlapping-claims';
  overlapping_agents?: string[];
}

export interface AttributedParticipantState {
  agent_id: string;
  claim_id?: string;
  intent: string;
  scope_paths: string[];
  scope_symbols: string[];


  delta: InFlightSemanticDelta;
}









export interface TiebrokenSymbolDelta extends SemanticSymbolDelta {
  agent_id: string;




  via: 'announced-edit' | 'unclaimed-edit';


  change: SymbolChange;
}

export interface AttributedInFlightState {
  workspace: string;
  attribution_source: 'participant-semantic-streams' | 'workspace-semantic-fallback';
  available: boolean;
  reason?: string;
  participants: AttributedParticipantState[];


  tiebroken: TiebrokenSymbolDelta[];



  unattributed: UnattributedSymbolDelta[];
}

function normalizeForPathMatch(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}


function fileWithinScopePath(file: string, scopePath: string): boolean {
  const nf = normalizeForPathMatch(file);
  const ns = normalizeForPathMatch(scopePath);
  if (!ns) return false;
  return nf === ns || nf.startsWith(`${ns}/`);
}

function claimCoversSymbol(claim: WorkClaim, delta: SemanticSymbolDelta): boolean {
  const scope = claim.scope;
  if (scope.symbols?.includes(delta.symbol_id)) return true;
  if (delta.file && scope.paths?.some((p) => fileWithinScopePath(delta.file!, p))) return true;
  return false;
}

function semanticDeltaFromChange(change: SymbolChange): SemanticSymbolDelta {
  const kind: SemanticSymbolDeltaKind = change.change_kind === 'add'
    ? 'added'
    : change.change_kind === 'delete'
      ? 'removed'
      : 'changed';
  return {
    symbol_id: change.symbol_id,
    name: change.name,
    file: change.file,
    kind,
    fields_changed: kind === 'changed' ? [change.change_kind] : undefined,
  };
}

function nodeIdsForChange(cas: CASOutput | null, change: SymbolChange): string[] {
  if (!cas) return [];
  const exact = cas.nodes.find((node) => node.id === change.symbol_id);
  if (exact) return [exact.id];
  const file = normalizeForPathMatch(change.file);
  return cas.nodes
    .filter((node) => normalizeForPathMatch(node.source?.file ?? '') === file)
    .filter((node) => node.name === change.name || node.name.endsWith(`.${change.name}`))
    .map((node) => node.id);
}

async function deltaFromParticipantSnapshot(
  workspace: string,
  snapshot: ParticipantInFlightSnapshot
): Promise<InFlightSemanticDelta> {
  const [main, inflight] = await Promise.all([
    loadAnalysis(workspace, { preferCache: true, track: 'main' }).catch(() => null),
    loadAnalysis(workspace, { preferCache: true, track: 'in-flight' }).catch(() => null),
  ]);
  const cas = inflight ?? main;
  const changes = snapshot.changes ?? [];
  const changedNodeIds = new Set(changes.flatMap((change) => nodeIdsForChange(cas, change)));
  const touchedFlows = flowsTouchedBy(cas, changedNodeIds);
  const touchedEntryPointIds = new Set((cas?.entry_points ?? [])
    .filter((entryPoint) => changedNodeIds.has(entryPoint.source_node) || changedNodeIds.has(entryPoint.handler?.node_id ?? ''))
    .map((entryPoint) => entryPoint.id));
  const touchedCapabilities = (cas?.capabilities ?? [])
    .filter((capability) => capability.operations.some((operation) => touchedEntryPointIds.has(operation.entry_point_id)))
    .map((capability) => ({ id: capability.id, name: capability.name }));
  const entryPoints = (cas?.entry_points ?? [])
    .filter((entryPoint) => touchedEntryPointIds.has(entryPoint.id))
    .map((entryPoint) => ({ id: entryPoint.id, name: entryPoint.name, kind: 'touched' as const }));
  return {
    workspace,
    participant_id: snapshot.agent_id,
    available: true,
    main_present: Boolean(main),
    inflight_present: Boolean(inflight),
    symbols: changes.map(semanticDeltaFromChange),
    entry_points: entryPoints,
    flows_touched: touchedFlows,
    capabilities_touched: touchedCapabilities,
    changes,
  };
}

async function participantSnapshotState(
  workspace: string,
  claims: WorkClaim[],
  snapshots: ParticipantInFlightSnapshot[]
): Promise<AttributedInFlightState> {
  const participants = await Promise.all(snapshots.map(async (snapshot): Promise<AttributedParticipantState> => {
    const agentClaims = claims.filter((candidate) => candidate.agent_id === snapshot.agent_id);
    const claim = agentClaims.find((candidate) => (candidate.scope.paths?.length ?? 0) > 0 || (candidate.scope.symbols?.length ?? 0) > 0)
      ?? agentClaims[0];
    return {
      agent_id: snapshot.agent_id,
      claim_id: claim?.claim_id,
      intent: claim?.intent ?? '',
      scope_paths: claim?.scope.paths ?? [],
      scope_symbols: claim?.scope.symbols ?? [],
      delta: await deltaFromParticipantSnapshot(workspace, snapshot),
    };
  }));
  return {
    workspace,
    attribution_source: 'participant-semantic-streams',
    available: true,
    participants,
    tiebroken: [],
    unattributed: [],
  };
}

















function tiebreakCandidatesForFile(
  log: ClaimLogEntry[],
  file: string
): { announced: Set<string>; unclaimedNamed: Set<string> } {
  const announced = new Set<string>();
  const unclaimedNamed = new Set<string>();
  for (const entry of log) {
    const paths = entry.scope?.paths ?? [];
    if (!paths.some((p) => fileWithinScopePath(file, p))) continue;
    if (entry.kind === 'unclaimed-edit') {
      if (entry.agent_id && entry.agent_id !== 'unknown') unclaimedNamed.add(entry.agent_id);
    } else if (entry.kind !== 'ambiguous-edit' && entry.kind !== 'surprise') {
      announced.add(entry.agent_id);
    }
  }
  return { announced, unclaimedNamed };
}








async function applyWriteHookTiebreaker(
  workspace: string,
  raw: InFlightSemanticDelta,
  unattributed: UnattributedSymbolDelta[]
): Promise<{ tiebroken: TiebrokenSymbolDelta[]; stillUnattributed: UnattributedSymbolDelta[] }> {
  if (unattributed.length === 0) return { tiebroken: [], stillUnattributed: [] };

  let log: ClaimLogEntry[] = [];
  try {
    log = await readClaimLog(workspace);
  } catch {


    return { tiebroken: [], stillUnattributed: unattributed };
  }

  const changesBySymbolId = new Map(raw.changes.map((c) => [c.symbol_id, c]));
  const tiebroken: TiebrokenSymbolDelta[] = [];
  const stillUnattributed: UnattributedSymbolDelta[] = [];

  for (const u of unattributed) {
    const change = u.file ? changesBySymbolId.get(u.symbol_id) : undefined;
    if (!u.file || !change) {
      stillUnattributed.push(u);
      continue;
    }
    const { announced, unclaimedNamed } = tiebreakCandidatesForFile(log, u.file);
    const combined = new Set<string>([...announced, ...unclaimedNamed]);
    if (combined.size === 1) {
      const agentId = [...combined][0];
      const { reason: _reason, overlapping_agents: _overlapping, ...delta } = u;
      tiebroken.push({
        ...delta,
        agent_id: agentId,
        via: announced.has(agentId) ? 'announced-edit' : 'unclaimed-edit',
        change,
      });
    } else {
      stillUnattributed.push(u);
    }
  }

  return { tiebroken, stillUnattributed };
}











export async function getAttributedInFlightState(
  workspace: string,
  options: { nowMs?: number } = {}
): Promise<AttributedInFlightState> {
  const [claims, snapshots] = await Promise.all([
    getActiveClaims(workspace, options.nowMs),
    readParticipantInFlightSnapshots(workspace, { nowMs: options.nowMs, attributableOnly: true }),
  ]);
  if (snapshots.length > 0) return participantSnapshotState(workspace, claims, snapshots);

  const raw = await getInFlightSemanticDelta(workspace, '__whole_tree__');

  if (!raw.available) {
    return {
      workspace,
      attribution_source: 'workspace-semantic-fallback',
      available: false,
      reason: raw.reason,
      participants: [],
      tiebroken: [],
      unattributed: [],
    };
  }
  if (claims.length === 0) {
    const wholeTreeUnattributed = raw.symbols.map((s): UnattributedSymbolDelta => ({ ...s, reason: 'unclaimed' as const }));
    const { tiebroken, stillUnattributed } = await applyWriteHookTiebreaker(workspace, raw, wholeTreeUnattributed);
    return {
      workspace,
      attribution_source: 'workspace-semantic-fallback',
      available: true,
      reason: 'no active claims in this workspace — the in-flight delta exists but nobody has claimed any scope to attribute it to',
      participants: [],
      tiebroken,
      unattributed: stillUnattributed,
    };
  }


  const coveringAgentsBySymbol = new Map<string, string[]>();
  for (const delta of raw.symbols) {
    const covering = claims.filter((c) => claimCoversSymbol(c, delta)).map((c) => c.agent_id);
    coveringAgentsBySymbol.set(delta.symbol_id, covering);
  }

  const participants: AttributedParticipantState[] = claims.map((claim) => {
    const mySymbols = raw.symbols.filter((d) => {
      const covering = coveringAgentsBySymbol.get(d.symbol_id) ?? [];
      return covering.length === 1 && covering[0] === claim.agent_id;
    });
    const mySymbolIds = new Set(mySymbols.map((s) => s.symbol_id));
    const myChanges = raw.changes.filter((c) => mySymbolIds.has(c.symbol_id));
    const myEntryPoints = raw.entry_points;

    return {
      agent_id: claim.agent_id,
      claim_id: claim.claim_id,
      intent: claim.intent,
      scope_paths: claim.scope.paths ?? [],
      scope_symbols: claim.scope.symbols ?? [],
      delta: {
        workspace,
        participant_id: claim.agent_id,
        available: true,
        main_present: raw.main_present,
        inflight_present: raw.inflight_present,
        symbols: mySymbols,
        entry_points: myEntryPoints,




        flows_touched: raw.flows_touched,
        capabilities_touched: raw.capabilities_touched,
        changes: myChanges,
      },
    };
  });

  const unattributedBeforeTiebreak: UnattributedSymbolDelta[] = raw.symbols
    .map((d): UnattributedSymbolDelta | null => {
      const covering = coveringAgentsBySymbol.get(d.symbol_id) ?? [];
      if (covering.length === 1) return null;
      if (covering.length === 0) return { ...d, reason: 'unclaimed' };
      return { ...d, reason: 'overlapping-claims', overlapping_agents: covering };
    })
    .filter((d): d is UnattributedSymbolDelta => d !== null);

  const { tiebroken, stillUnattributed } = await applyWriteHookTiebreaker(workspace, raw, unattributedBeforeTiebreak);

  return {
    workspace,
    attribution_source: 'workspace-semantic-fallback',
    available: true,
    participants,
    tiebroken,
    unattributed: stillUnattributed,
  };
}


















export async function detectConceptualConflictsFromSubstrate(
  workspace: string,
  cas: ConflictCas,
  options: DetectConceptualConflictsOptions = {}
): Promise<{ conflicts: ConceptualConflict[]; attributed: AttributedInFlightState }> {
  const attributed = await getAttributedInFlightState(workspace);
  if (!attributed.available) {
    return { conflicts: [], attributed };
  }

  const stateByAgent = new Map<string, AgentInFlightState>();
  for (const p of attributed.participants) {
    if (p.delta.changes.length === 0) continue;
    const existing = stateByAgent.get(p.agent_id);
    if (existing) {
      existing.changes.push(...p.delta.changes);
    } else {
      stateByAgent.set(p.agent_id, { agent_id: p.agent_id, intent: p.intent, changes: [...p.delta.changes] });
    }
  }
  for (const t of attributed.tiebroken) {
    const existing = stateByAgent.get(t.agent_id);
    if (existing) {
      existing.changes.push(t.change);
    } else {
      stateByAgent.set(t.agent_id, { agent_id: t.agent_id, intent: `write-hook tiebreak (${t.via})`, changes: [t.change] });
    }
  }

  const states: AgentInFlightState[] = [...stateByAgent.values()];

  if (states.length < 2) {


    return { conflicts: [], attributed };
  }

  const conflicts = detectConceptualConflicts(states, cas, options);
  return { conflicts, attributed };
}
