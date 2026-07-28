/**
 * Structured intent, reduced — `produces` / `consumes`, AUTO-DERIVED
 * (docs/SPEC-COORDINATION-ENGINE.md §3, wave 2).
 *
 * WHY AUTO-DERIVATION IS THE POINT. Explicit declaration is the high-signal
 * path ("declare your exports; peers build against them immediately"), but the
 * board must not depend on diligence: v1 WS-E showed agents skip every
 * check-in tax, and a contract board that only lazy-agent-free fleets populate
 * flatlines. So OBSERVATION IS THE FLOOR — a lane that declares nothing still
 * powers the board, because ambient capture's `SymbolChange[]` is lifted into
 * `produces` (`status:'observed'`) and cross-referenced into peers' `consumes`
 * with no writer action at all.
 *
 * WHAT THIS DELIBERATELY IS NOT (cut by the v1.1 cold review, Appendix B —
 * do not reintroduce): no `goal` field, no self-reported `phase` and no
 * `set_phase` tool (phase is DERIVED here, see `derivePhase`), no
 * `declared → draft → stable` status lifecycle, no `from_agent`/`declared`
 * flags on consumes. Self-reported state is the tax; stale self-reports are
 * worse than none. What remains is only what the machine can verify plus the
 * minimum a reader actually consults.
 *
 * PURE MODULE: no IO, no transport, no storage reads. Everything is a function
 * of data the caller passes in (mirrors collision.ts / conceptual-conflict.ts).
 */

import type { SymbolChange } from './conceptual-conflict';
import type { ContractKind, DeclaredContract, DerivedPhase } from './types';

// ---------------------------------------------------------------------------
// Caps (§14 engineering hygiene: one pathological claim must not dominate the
// log or any response). Applied at derivation time, so an oversized diff can
// never write an oversized claim entry.
// ---------------------------------------------------------------------------

/** Max contracts kept on one claim's `produces` (declared + observed, post-merge). */
export const MAX_CONTRACTS_PER_CLAIM = 64;
/** Max names kept on one claim's `consumes`. */
export const MAX_CONSUMES_PER_CLAIM = 64;
/** Max chars of a `signature` / `notes` string before truncation-with-marker. */
export const MAX_CONTRACT_TEXT = 512;

const TRUNCATION_MARKER = '…[truncated]';

/** Cap one free-text contract string, marking it when cut (never silently). */
export function capContractText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  if (text.length <= MAX_CONTRACT_TEXT) return text;
  return text.slice(0, MAX_CONTRACT_TEXT - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

// ---------------------------------------------------------------------------
// Contract identity — `(kind, name, path?)`
// ---------------------------------------------------------------------------

function normalizePath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * The identity key for a contract: `(kind, name, path?)`. Two contracts with
 * the same key ARE the same contract; a declared entry and an observed entry
 * sharing it are two provenances of one fact (see `mergeContracts`).
 */
export function contractIdentity(c: Pick<DeclaredContract, 'kind' | 'name' | 'path'>): string {
  return `${c.kind}::${c.name}::${normalizePath(c.path) ?? ''}`;
}

/**
 * How strongly a consumer's reference resolves to a producer's contract.
 * `path_qualified` = the consumer named a path and it matches — unambiguous.
 * `name_only` = the consumer named no path, OR two same-named contracts exist:
 * a real match, reported at LOWER CONFIDENCE and labeled as such wherever it
 * surfaces in findings (§3: name-only matching is allowed, never silently
 * promoted to certainty).
 */
export type ContractMatchConfidence = 'path_qualified' | 'name_only';

export interface ContractMatch {
  contract: DeclaredContract;
  confidence: ContractMatchConfidence;
  /** True when >1 candidate shared the name — the match is a coin-flip among them. */
  ambiguous: boolean;
}

/**
 * Resolve a reference (`name`, optionally path-qualified, optionally
 * kind-qualified) against a pool of contracts. Path-qualified matches are
 * preferred and returned alone; otherwise every name match is returned as
 * `name_only`, flagged `ambiguous` when there is more than one.
 */
export function matchContract(
  ref: { name: string; path?: string; kind?: ContractKind },
  pool: DeclaredContract[]
): ContractMatch[] {
  const byName = pool.filter((c) => c.name === ref.name && (!ref.kind || c.kind === ref.kind));
  if (byName.length === 0) return [];
  const refPath = normalizePath(ref.path);
  if (refPath) {
    const exact = byName.filter((c) => normalizePath(c.path) === refPath);
    if (exact.length > 0) {
      return exact.map((c) => ({ contract: c, confidence: 'path_qualified' as const, ambiguous: exact.length > 1 }));
    }
  }
  return byName.map((c) => ({ contract: c, confidence: 'name_only' as const, ambiguous: byName.length > 1 }));
}

/**
 * Merge declared and observed contracts into one board view.
 * EXPLICIT ALWAYS WINS for the same identity (a declaration is INTENT; an
 * observation is only evidence of activity) — but the observation's concrete
 * `signature` is folded in when the declaration carried none, so the board
 * never loses the machine-known shape. Both provenances stay visible via
 * `status`; nothing is silently rewritten.
 */
export function mergeContracts(
  declared: DeclaredContract[] = [],
  observed: DeclaredContract[] = []
): DeclaredContract[] {
  const out = new Map<string, DeclaredContract>();
  for (const c of declared) {
    out.set(contractIdentity(c), {
      ...c,
      signature: capContractText(c.signature),
      notes: capContractText(c.notes),
      status: c.status ?? 'declared',
    });
  }
  for (const c of observed) {
    const id = contractIdentity(c);
    const prior = out.get(id);
    if (!prior) {
      out.set(id, { ...c, signature: capContractText(c.signature), notes: capContractText(c.notes), status: 'observed' });
      continue;
    }
    if (prior.status === 'declared' || prior.status === undefined) {
      // Declaration wins on identity + intent; only fill a gap it left.
      if (!prior.signature && c.signature) prior.signature = capContractText(c.signature);
      continue;
    }
    out.set(id, { ...prior, ...c, signature: capContractText(c.signature ?? prior.signature), status: 'observed' });
  }
  return [...out.values()].slice(0, MAX_CONTRACTS_PER_CLAIM);
}

// ---------------------------------------------------------------------------
// Auto-derivation 1 — observed `produces` (§3 auto-derivation item 1)
// ---------------------------------------------------------------------------

/**
 * Change kinds that move a CONTRACT SURFACE. `body` is excluded on purpose:
 * a body edit is exactly the semantic/behavioral change this layer does NOT
 * model (see the scope-honesty note on `detectDeclaredContractDrift`), and
 * lifting every body edit into `produces` would drown the board.
 */
const SURFACE_CHANGE_KINDS = new Set<SymbolChange['change_kind']>([
  'signature',
  'return_type',
  'nullability',
  'param',
  'rename',
  'split',
  'move',
  'delete',
  'add',
]);

/** in-flight-capture's sentinel for "a file changed in a language we don't parse". */
const UNPARSED_FILE_SENTINEL = '__file__';

function isSurfaceChange(change: SymbolChange): boolean {
  if (!SURFACE_CHANGE_KINDS.has(change.change_kind)) return false;
  // A whole-file "we couldn't parse this" fallback names no contract — lifting
  // it would fabricate an export that does not exist.
  if (change.symbol_id.endsWith(`:${UNPARSED_FILE_SENTINEL}`)) return false;
  return !!change.name;
}

function contractKindForChange(change: SymbolChange): ContractKind {
  if (change.change_kind === 'add' || change.change_kind === 'delete' || change.change_kind === 'move') {
    return 'export';
  }
  return 'signature';
}

/**
 * AUTO-LIFT (§3 auto-derivation 1): turn a participant's ambient
 * `SymbolChange[]` into `produces` entries with `status:'observed'` — the same
 * shape a declaration uses, machine-derived, zero writer action. A lane that
 * never declares anything still shows the fleet what contracts it is moving.
 *
 * ATTRIBUTION PRECONDITION (§13): the caller must pass changes ALREADY
 * attributed to this one participant (getAttributedInFlightState's
 * per-participant delta). On a shared tree, two agents' edits are one diff and
 * attribution is fiction — the caller disables auto-lift there rather than
 * producing confident nonsense (see `isAttributionSound`).
 */
export function deriveObservedProduces(changes: SymbolChange[]): DeclaredContract[] {
  const out = new Map<string, DeclaredContract>();
  for (const change of changes) {
    if (!isSurfaceChange(change)) continue;
    const contract: DeclaredContract = {
      kind: contractKindForChange(change),
      name: change.name,
      path: normalizePath(change.file),
      signature: capContractText(change.after?.signature ?? change.before?.signature),
      status: 'observed',
    };
    const id = contractIdentity(contract);
    if (!out.has(id)) out.set(id, contract);
    if (out.size >= MAX_CONTRACTS_PER_CLAIM) break;
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Auto-derivation 2 — observed `consumes` (§3 auto-derivation item 2)
// ---------------------------------------------------------------------------

/** One peer lane's contract board, as seen by the consumer-side matcher. */
export interface PeerContracts {
  agent_id: string;
  claim_id: string;
  contracts: DeclaredContract[];
}

export interface ObservedConsumesResult {
  /** Contract names to record on the observing participant's `consumes`. */
  names: string[];
  /** One edge per (contract, producer) resolved, with match confidence. */
  edges: Array<{
    name: string;
    producer_agent_id: string;
    producer_claim_id: string;
    confidence: ContractMatchConfidence;
    ambiguous: boolean;
    evidence: string;
  }>;
}

/**
 * Textual references a change carries that can name a peer's contract: the
 * new/old signature and return type (a type USE), the symbol's own name (a
 * call site renamed into existence is rare, but a re-export is not), plus any
 * raw added-diff text the caller can supply (import lines / new call sites,
 * which symbol-level capture does not model on its own).
 */
function referenceHaystack(change: SymbolChange, addedTextByFile: Map<string, string>): string {
  return [
    change.after?.signature,
    change.after?.return_type,
    change.before?.signature,
    change.before?.return_type,
    addedTextByFile.get(normalizePath(change.file) ?? change.file),
  ]
    .filter(Boolean)
    .join('\n');
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does `haystack` reference `contract` by name at a token boundary? Endpoint
 * contracts ("GET /v1/x") match on their path portion, since a call site names
 * the route, not the verb+route string.
 */
function referencesContract(haystack: string, contract: DeclaredContract): boolean {
  const needle =
    contract.kind === 'endpoint' && /\s/.test(contract.name)
      ? contract.name.slice(contract.name.indexOf(' ') + 1).trim()
      : contract.name;
  if (!needle) return false;
  // Token-boundary match: `getUser` must not match `getUserProfile`. `\b` is
  // wrong for path-shaped needles ("/v1/x"), so bound on non-identifier chars.
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$/])${escapeForRegex(needle)}([^A-Za-z0-9_$]|$)`);
  return pattern.test(haystack);
}

/**
 * AUTO-RECORD (§3 auto-derivation 2): when this participant's ambient diff
 * references a contract a PEER declares or is observed producing, record a
 * `consumes` edge on this participant's claim. The dependency graph between
 * in-flight lanes assembles itself — and it is that graph the drift detector
 * walks to decide WHO hears about a divergence.
 *
 * Self-produced contracts are excluded (`ownContracts`): a lane does not
 * consume what it produces.
 */
export function deriveObservedConsumes(
  input: { changes: SymbolChange[]; addedTextByFile?: Record<string, string> },
  peers: PeerContracts[],
  ownContracts: DeclaredContract[] = []
): ObservedConsumesResult {
  const addedText = new Map(Object.entries(input.addedTextByFile ?? {}).map(([k, v]) => [normalizePath(k) ?? k, v]));
  const ownIds = new Set(ownContracts.map((c) => contractIdentity(c)));
  const ownNames = new Set(ownContracts.map((c) => c.name));
  const names = new Set<string>();
  const edges: ObservedConsumesResult['edges'] = [];
  const seenEdges = new Set<string>();

  for (const change of input.changes) {
    const haystack = referenceHaystack(change, addedText);
    if (!haystack) continue;
    for (const peer of peers) {
      for (const contract of peer.contracts) {
        if (ownIds.has(contractIdentity(contract)) || ownNames.has(contract.name)) continue;
        if (!referencesContract(haystack, contract)) continue;
        // A peer contract living in the very file this change edits is not a
        // cross-lane dependency signal — it's the same surface being co-edited,
        // which the overlap detectors already report.
        const edgeKey = `${peer.claim_id}::${contractIdentity(contract)}`;
        if (seenEdges.has(edgeKey)) continue;
        seenEdges.add(edgeKey);
        const sameFileDecl = normalizePath(contract.path) && normalizePath(contract.path) === normalizePath(change.file);
        const nameMatches = peers.flatMap((p) => p.contracts).filter((c) => c.name === contract.name);
        edges.push({
          name: contract.name,
          producer_agent_id: peer.agent_id,
          producer_claim_id: peer.claim_id,
          confidence: sameFileDecl ? 'path_qualified' : 'name_only',
          ambiguous: nameMatches.length > 1,
          evidence: `${change.symbol_id} references ${contract.kind}:${contract.name}`,
        });
        names.add(contract.name);
        if (names.size >= MAX_CONSUMES_PER_CLAIM) break;
      }
    }
  }
  return { names: [...names].slice(0, MAX_CONSUMES_PER_CLAIM), edges };
}

/**
 * §13 attribution, applied PER CHANGE. Ambient capture diffs a whole working
 * tree, so before anything is lifted onto a claim we must know the change is
 * THIS claim's. A change is attributed to `myClaim` only when my scope covers
 * it AND no OTHER active claim's scope does — the same honesty rule
 * `getAttributedInFlightState` applies, at the cheap ambient tier. Everything
 * ambiguous is returned as `shared` and lifted by nobody: on a shared tree the
 * fleet keeps awareness (claims, overlap, unclaimed edits) and loses only
 * attribution, never gaining wrong attribution.
 *
 * A PATH-LESS (exploration) claim covers nothing, so nothing is attributed to
 * it — correct: an agent that has not said where it is working cannot be
 * credited with edits it may not have made.
 */
export function attributeChangesToClaim(
  changes: SymbolChange[],
  myClaim: { scope: { paths: string[]; symbols: string[] } },
  otherActiveClaims: Array<{ scope: { paths: string[]; symbols: string[] } }>
): { mine: SymbolChange[]; shared: SymbolChange[] } {
  const covers = (claim: { scope: { paths: string[]; symbols: string[] } }, change: SymbolChange): boolean => {
    if (claim.scope.symbols?.includes(change.symbol_id) || claim.scope.symbols?.includes(change.name)) return true;
    const file = normalizePath(change.file);
    if (!file) return false;
    return (claim.scope.paths ?? []).some((p) => {
      const np = normalizePath(p);
      return !!np && (file === np || file.startsWith(`${np}/`));
    });
  };
  const mine: SymbolChange[] = [];
  const shared: SymbolChange[] = [];
  for (const change of changes) {
    if (!covers(myClaim, change)) continue; // not mine — and not mine to guess about.
    if (otherActiveClaims.some((c) => covers(c, change))) shared.push(change);
    else mine.push(change);
  }
  return { mine, shared };
}

/**
 * §13 attribution gate. Ambient capture diffs A WORKING TREE, so "agent X
 * changed contract Y" is only sound when each participant has its own tree. On
 * a SHARED tree (two or more active claims resolving to one tree root) the
 * fleet still gets awareness — claims, footprint overlap, unclaimed edits —
 * but observed produces/consumes auto-lifting and per-agent drift blame are
 * DISABLED: less awareness, never wrong awareness.
 */
export function isAttributionSound(input: { participantsInTree: number }): boolean {
  return input.participantsInTree <= 1;
}

// ---------------------------------------------------------------------------
// Derived phase (display only)
// ---------------------------------------------------------------------------

const TEST_FILE_PATTERN = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rb)$|Test\.(java|kt|cs|swift)$/;

/**
 * DERIVE the phase for DISPLAY (§3: "phase is derived, never declared").
 * Readers get a phase signal with zero writer burden and zero staleness; there
 * is deliberately no `set_phase` and no field an agent can lie about or forget
 * to update.
 */
export function derivePhase(input: { changes?: SymbolChange[] }): DerivedPhase {
  const changes = input.changes ?? [];
  if (changes.length === 0) return 'exploring';
  if (changes.some((c) => TEST_FILE_PATTERN.test(c.file ?? ''))) return 'verifying';
  return 'building';
}

/**
 * The board-side phase derivation: same rule as `derivePhase`, but read off
 * what ambient observation already recorded on the claim, so listing the whole
 * fleet costs no diffs. `status:'observed'` contracts ARE the evidence of
 * edits; observed contracts in test files are the evidence of verifying.
 * Declared-only contracts are intent, not edits, and stay `exploring`.
 */
export function derivePhaseFromClaim(claim: { produces?: DeclaredContract[] }): DerivedPhase {
  const observed = (claim.produces ?? []).filter((c) => c.status === 'observed');
  if (observed.length === 0) return 'exploring';
  if (observed.some((c) => TEST_FILE_PATTERN.test(c.path ?? ''))) return 'verifying';
  return 'building';
}

// ---------------------------------------------------------------------------
// Path-less (exploration-phase) claims
// ---------------------------------------------------------------------------

/**
 * An arriving agent has no footprint yet (§3: it has not localized its work).
 * Such a claim MUST stay representable and visible rather than falling out of
 * the neighborhood model: with no paths and no symbols, every path-overlap
 * predicate is vacuously false, so a naive board silently drops it and the
 * fleet cannot see that someone is already looking at the area.
 */
export function isExplorationClaim(claim: {
  scope: { paths: string[]; symbols: string[] };
  produces?: DeclaredContract[];
}): boolean {
  return (
    (claim.scope.paths?.length ?? 0) === 0 &&
    (claim.scope.symbols?.length ?? 0) === 0 &&
    (claim.produces?.length ?? 0) === 0
  );
}

/** The nudge a path-less claim carries back to its owner, every time. */
export const EXPLORATION_CLAIM_NOTE =
  'This claim has NO paths/symbols yet — it is visible to the fleet as an exploration claim ' +
  '(phase: exploring), but it cannot participate in overlap detection or event drain until it ' +
  'has a footprint. Call fab_extend with add_paths/add_symbols (and declare `produces`) the ' +
  'moment you localize your work.';
