/**
 * In-flight substrate (W0, docs/SPEC-COORDINATION-FABRIC-V3.md §3, §8 row W0).
 *
 * v3's load-bearing claim: "the fabric is a consumer of a live, ATTRIBUTED,
 * SEMANTIC, CONTINUOUS analysis that includes uncommitted work." The seed
 * already exists — `analyzeProjectIncremental`/`saveAnalysis` persist a
 * `track:'in-flight'` CAS snapshot (dirty working tree) alongside the
 * committed `track:'main'` one (see `../track.ts`, `../storage.ts`
 * `trackSuffix`). Before this module, NOTHING read the in-flight track back
 * out for coordination purposes — `conceptual-conflict.ts`'s detectors were
 * fed exclusively from git-ambient capture (`in-flight-capture.ts`) or
 * agent self-reports, both ATTRIBUTION-FRAGILE on a shared working tree
 * (§3.2: "every participant's own diff is the union of everyone's").
 *
 * This module is the substrate those boxes should read from instead:
 *
 *   1. `getInFlightSemanticDelta` — the SEMANTIC delta between a project's
 *      committed (`main`) and dirty-working-tree (`in-flight`) analyses:
 *      symbols added/removed/changed (by identity — id/name/file/type, not
 *      by text line), entry points added/changed, and the flows/capabilities
 *      those changes touch. This is whole-tree (unattributed) by
 *      construction — see honesty note below.
 *
 *   2. `getAttributedInFlightState` — ATTRIBUTES that whole-tree delta to
 *      the workspace's currently-active claims (`local-store.ts`
 *      `getActiveClaims`), never from ambient `git diff`. A symbol is
 *      attributed to a participant when it falls in exactly ONE active
 *      claim's scope (declared symbol id, or a file under a claimed path).
 *
 *   3. `detectConceptualConflictsFromSubstrate` — re-bases
 *      `detectConceptualConflicts` (unchanged; the detectors themselves are
 *      good, per §8 W3) on the attributed per-participant deltas from (2)
 *      instead of git-diff-derived `AgentInFlightState[]`, so a finding
 *      compares each participant's OWN work, by construction — not "right
 *      by luck" the way ambient git capture is (§3.2's `plan_intent_merge`
 *      example).
 *
 * HONEST LIMITATION (evidence-gated, not asserted away): the `in-flight`
 * track is PER-PROJECT (one dirty working tree → one `.inflight` analysis
 * file — see `../track.ts` `revisionToTrack`), not per-participant. On a
 * SHARED working tree with multiple concurrent participants, the raw
 * whole-tree delta from (1) is exactly the same "union of everyone's work"
 * problem §3.2 describes for `git diff` — reading the in-flight CAS instead
 * of running `git diff` ourselves does not, by itself, solve attribution.
 * What this module does about it: `getAttributedInFlightState` treats a
 * changed symbol as attributable ONLY when it falls inside EXACTLY ONE
 * active claim's declared scope (paths/symbols) — zero claims covering it,
 * or two-or-more claims covering it, are BOTH treated as unattributable and
 * surfaced in the `unattributed` bucket, never guessed or silently assigned
 * to whichever participant happens to be asking.
 *
 * W4 STEP 1 ADDITION (docs/SPEC-COORDINATION-FABRIC-V3.md §8 W4, "re-base
 * on W0"): the write-hook (write-hook.ts, §8 W5) is now built and gives a
 * SECOND attribution source that W0 didn't have when this module was first
 * written — `announceEdit`/`recordUnclaimedEdit` claim-log entries name the
 * agent that actually touched a path, AS IT HAPPENED, independent of whether
 * a claim currently covers that path. `getAttributedInFlightState` now
 * consults that event log as a TIEBREAKER for anything that would otherwise
 * land in `unattributed`: if the full claim log (not just currently-active
 * claims — a write-hook announcement is still informative evidence after its
 * TTL expires or it gets superseded) shows exactly ONE distinct agent ever
 * announced/was-detected touching the delta's file, the delta is resolved to
 * that agent and reported in `tiebroken` (never folded into `participants`,
 * since it doesn't correspond to a live claim). Two-or-more distinct agents,
 * or zero, stay honestly in `unattributed` — this is a tiebreaker, not a
 * guesser.
 */

import type { CASNode, CASOutput } from '../../../../packages/analyzer-core/src/types/cas.types';
import { loadAnalysis } from '../storage';
import { getActiveClaims, readClaimLog, type ClaimLogEntry } from './local-store';
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

// ---------------------------------------------------------------------------
// Semantic delta model
// ---------------------------------------------------------------------------

export type SemanticSymbolDeltaKind = 'added' | 'removed' | 'changed';

export interface SemanticSymbolDelta {
  symbol_id: string;
  name: string;
  file?: string;
  type?: string;
  kind: SemanticSymbolDeltaKind;
  /** Which structural facets differ (only present for kind==='changed'), e.g. ['signature','return_type']. */
  fields_changed?: string[];
}

export interface EntryPointDelta {
  id: string;
  name: string;
  kind: 'added' | 'removed';
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
  /** false when there is no in-flight (dirty working tree) analysis to read at all. */
  available: boolean;
  reason?: string;
  main_present: boolean;
  inflight_present: boolean;
  symbols: SemanticSymbolDelta[];
  entry_points: EntryPointDelta[];
  flows_touched: FlowTouch[];
  capabilities_touched: CapabilityTouch[];
  /**
   * The delta, pre-shaped as `SymbolChange[]` — ready to drop straight into
   * `detectConceptualConflicts` (via an `AgentInFlightState`) alongside any
   * other participant's changes. One entry per non-'removed'-without-shape
   * symbol delta; see `toSymbolChange`.
   */
  changes: SymbolChange[];
}

// ---------------------------------------------------------------------------
// Node/entry-point comparison helpers
// ---------------------------------------------------------------------------

function nodeSignatureString(node: CASNode): string | undefined {
  const sig = node.signature;
  if (!sig) return undefined;
  const params = (sig.parameters || [])
    .map((p: { name: string; type?: string; optional?: boolean; default_value?: string }) =>
      `${p.name}${p.optional ? '?' : ''}:${p.type ?? 'any'}${p.default_value !== undefined ? `=${p.default_value}` : ''}`)
    .join(', ');
  return `(${params})${sig.return_type ? `: ${sig.return_type}` : ''}`;
}

/** Best-effort nullability read off a return-type annotation string. Undefined when there's no return type to read. */
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

/**
 * Semantic node diff between two CAS node sets, by node id. Mirrors the same
 * facets `AnalyzerOrchestrator.buildChangeReport` (packages/analyzer-core)
 * compares for its own incremental-analysis change reports (metadata /
 * signature / location) — reused here in shape rather than reinvented, since
 * that method is private to the orchestrator and not directly callable on
 * two already-loaded `CASOutput`s.
 */
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
  if (!cas?.system_capabilities) return [];
  const touched: CapabilityTouch[] = [];
  for (const cap of cas.system_capabilities) {
    const hits = (cap.operations || []).some((op) => changedEntryPointIds.has(op.entry_point_id));
    if (hits) touched.push({ id: cap.id, name: cap.name });
  }
  return touched;
}

// ---------------------------------------------------------------------------
// (1) getInFlightSemanticDelta — whole-tree (unattributed) semantic delta
// ---------------------------------------------------------------------------

/**
 * The semantic delta between a project's committed (`main`) analysis and its
 * dirty-working-tree (`in-flight`) analysis. `participantId` is carried
 * through for labeling/logging only at this layer — this function itself
 * reads the WHOLE-TREE delta (there is only one `in-flight` track per
 * project, see the module doc's honesty note); attribution to a specific
 * participant happens one layer up, in `getAttributedInFlightState`.
 */
export async function getInFlightSemanticDelta(
  workspacePath: string,
  participantId: string
): Promise<InFlightSemanticDelta> {
  const [mainCas, inflightCas] = await Promise.all([
    loadAnalysis(workspacePath, { track: 'main' }).catch(() => null),
    loadAnalysis(workspacePath, { track: 'in-flight' }).catch(() => null),
  ]);

  const mainPresent = Boolean(mainCas);
  const inflightPresent = Boolean(inflightCas);

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

// ---------------------------------------------------------------------------
// (2) getAttributedInFlightState — attribute the whole-tree delta to claims
// ---------------------------------------------------------------------------

export interface UnattributedSymbolDelta extends SemanticSymbolDelta {
  /** 'unclaimed' = no active claim's scope covers this symbol/file.
   *  'overlapping-claims' = TWO OR MORE active claims' scopes cover it — on a
   *  shared tree we cannot tell whose edit it actually is, so (per the
   *  module's honesty note) it is surfaced here rather than assigned to
   *  either claimant. */
  reason: 'unclaimed' | 'overlapping-claims';
  overlapping_agents?: string[];
}

export interface AttributedParticipantState {
  agent_id: string;
  claim_id: string;
  intent: string;
  scope_paths: string[];
  scope_symbols: string[];
  /** This participant's ATTRIBUTED slice of the workspace's whole-tree in-flight delta — only the
   *  symbols/changes that fall in this participant's claim scope AND no other active claim's scope. */
  delta: InFlightSemanticDelta;
}

/**
 * A delta resolved via the write-hook's event log (announced-edit or
 * unclaimed-edit-with-a-named-detector) rather than an active claim's scope —
 * the SECOND attribution source (W4 step 1). Kept separate from
 * `AttributedParticipantState` because it does not correspond to a live
 * claim (the announcing claim may since have expired/been superseded), and
 * separate from `unattributed` because it IS resolved to exactly one agent.
 */
export interface TiebrokenSymbolDelta extends SemanticSymbolDelta {
  agent_id: string;
  /** 'announced-edit' = a claim-log entry (any status) whose scope covers this file names the
   *  agent (announceEdit / a regular claim / the write-hook's auto-announce all produce these).
   *  'unclaimed-edit' = a `recordUnclaimedEdit` event log entry for this exact file named a real
   *  agent via `detectedBy` (not the 'unknown' default). */
  via: 'announced-edit' | 'unclaimed-edit';
  /** The pre-shaped SymbolChange for this delta, ready to fold into an `AgentInFlightState` for
   *  `planIntentMerge`/`detectConceptualConflicts`, same shape `AttributedParticipantState.delta.changes` uses. */
  change: SymbolChange;
}

export interface AttributedInFlightState {
  workspace: string;
  available: boolean;
  reason?: string;
  participants: AttributedParticipantState[];
  /** Deltas resolved via the write-hook's announced-edit/unclaimed-edit event log when no single
   *  active claim covered them (W4 step 1 — the 2nd attribution source; see `TiebrokenSymbolDelta`). */
  tiebroken: TiebrokenSymbolDelta[];
  /** Changes present in the raw in-flight delta that could not be honestly attributed to exactly one
   *  active participant NOR resolved by the write-hook tiebreaker (see `UnattributedSymbolDelta.reason`).
   *  Never silently assigned. */
  unattributed: UnattributedSymbolDelta[];
}

function normalizeForPathMatch(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** True when `file` is `scopePath` itself, or lives under it (directory-prefix match). */
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

// ---------------------------------------------------------------------------
// Write-hook event log tiebreaker (W4 step 1 — the 2nd attribution source)
// ---------------------------------------------------------------------------

/**
 * Every distinct agent_id the FULL claim log (all statuses — an expired or
 * superseded announcement is still evidence of who wrote there, unlike
 * `getActiveClaims`) names for `file`, split by which kind of event named it:
 *  - `announced`: any log entry (kind !== 'unclaimed-edit' — i.e. an ordinary
 *    claim OR an `announceEdit` edit-lock, which is what the write-hook's
 *    auto-announce path produces) whose scope.paths covers `file`.
 *  - `unclaimedNamed`: a `recordUnclaimedEdit` ('unclaimed-edit') entry for
 *    this exact file whose `agent_id` is a real detected agent, not the
 *    'unknown' default (an anonymous unclaimed-edit event names nobody, so it
 *    is never a tiebreak candidate).
 */
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
    } else {
      announced.add(entry.agent_id);
    }
  }
  return { announced, unclaimedNamed };
}

/**
 * Resolve as many `unattributed` deltas as honestly possible using the
 * write-hook's event log as a tiebreaker (W4 step 1). Returns the deltas that
 * WERE resolved (`tiebroken`) separately from the ones that remain genuinely
 * unattributable (`stillUnattributed`) — a delta with 0 or 2+ distinct naming
 * agents in the event log is left alone, never guessed.
 */
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
    // No claim log at all (fresh workspace) — nothing to tiebreak with; every
    // unattributed delta stays that way. Never a hard failure of this path.
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

/**
 * Attribute a workspace's whole-tree in-flight semantic delta to its
 * currently-active claims (`local-store.ts` `getActiveClaims` — NEVER
 * ambient `git diff`, per the module's cardinal rule). A symbol is
 * attributed to a participant only when EXACTLY ONE active claim's scope
 * covers it; zero or 2+ covering claims land in `unattributed` instead of
 * being guessed. `workspace` doubles as the project path, matching every
 * other call site in this codebase (claims are always scoped `repo:
 * workspace`, and `getAnalysis(workspace)` reads the same path).
 */
export async function getAttributedInFlightState(
  workspace: string,
  options: { nowMs?: number } = {}
): Promise<AttributedInFlightState> {
  const [claims, raw] = await Promise.all([
    getActiveClaims(workspace, options.nowMs),
    getInFlightSemanticDelta(workspace, '__whole_tree__'),
  ]);

  if (!raw.available) {
    return { workspace, available: false, reason: raw.reason, participants: [], tiebroken: [], unattributed: [] };
  }
  if (claims.length === 0) {
    const wholeTreeUnattributed = raw.symbols.map((s): UnattributedSymbolDelta => ({ ...s, reason: 'unclaimed' as const }));
    const { tiebroken, stillUnattributed } = await applyWriteHookTiebreaker(workspace, raw, wholeTreeUnattributed);
    return {
      workspace,
      available: true,
      reason: 'no active claims in this workspace — the in-flight delta exists but nobody has claimed any scope to attribute it to',
      participants: [],
      tiebroken,
      unattributed: stillUnattributed,
    };
  }

  // For each changed symbol, which claims' scopes cover it?
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
    const myEntryPoints = raw.entry_points; // entry points are workspace-wide awareness, not claim-scoped (no per-EP claim scope exists yet)

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
        // Awareness-only, deliberately workspace-wide rather than claim-narrowed here (§4: "awareness is
        // never gated") — narrowing flows/capabilities to a participant's OWN claimed symbols would need
        // call_path/operation membership re-computed per participant, which isn't built yet; passing the
        // raw whole-tree set through is honest (no fake per-participant split) and still useful context.
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

  return { workspace, available: true, participants, tiebroken, unattributed: stillUnattributed };
}

// ---------------------------------------------------------------------------
// (3) detectConceptualConflictsFromSubstrate — re-based crown jewel
// ---------------------------------------------------------------------------

/**
 * `detectConceptualConflicts` (conceptual-conflict.ts) is UNCHANGED by this
 * module — its five detectors stay exactly as they were (§8 W3: "the
 * detectors themselves are good"). What changes is where the input
 * `AgentInFlightState[]` comes from: instead of git-ambient capture or
 * self-reported markers (server.ts `otherAgentConceptualStates`,
 * `remote-analyzer-service.ts` `otherAgentConceptualStatesHttp` — both left
 * untouched, still valid, still the git-based path for callers that haven't
 * migrated), this reads the ATTRIBUTED per-participant deltas from
 * `getAttributedInFlightState` above. Two participants' deltas are then
 * compared as THEIR OWN attributed work — converting the "right by luck"
 * problem (§3.2) into "right by construction": a participant whose changes
 * are unattributable (unclaimed or claim-overlapping) simply contributes no
 * `AgentInFlightState` entry, rather than being silently folded into
 * whoever happens to be asking.
 */
export async function detectConceptualConflictsFromSubstrate(
  workspace: string,
  cas: ConflictCas,
  options: DetectConceptualConflictsOptions = {}
): Promise<{ conflicts: ConceptualConflict[]; attributed: AttributedInFlightState }> {
  const attributed = await getAttributedInFlightState(workspace);
  if (!attributed.available || attributed.participants.length === 0) {
    return { conflicts: [], attributed };
  }

  const states: AgentInFlightState[] = attributed.participants
    .filter((p) => p.delta.changes.length > 0)
    .map((p) => ({ agent_id: p.agent_id, intent: p.intent, changes: p.delta.changes }));

  if (states.length < 2) {
    // Need at least two participants with attributed changes for any
    // cross-participant detector to have something to compare.
    return { conflicts: [], attributed };
  }

  const conflicts = detectConceptualConflicts(states, cas, options);
  return { conflicts, attributed };
}
