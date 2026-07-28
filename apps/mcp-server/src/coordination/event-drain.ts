/**
 * Claim-scoped event delivery — THE CLAIM IS THE SUBSCRIPTION
 * (docs/SPEC-COORDINATION-ENGINE.md §5, wave 2).
 *
 * WHAT THIS REPLACES. v1.0 specified a registration step (`kind:'subscription'`
 * entries), a five-variant interest taxonomy, digest overflow, and
 * per-subscriber filtered SSE. All of that is DELIBERATELY NOT BUILT
 * (Appendix B): a registration step is a second check-in tax on top of the
 * claim the agent already made, and an interest taxonomy just re-describes
 * what the claim already carries — its footprint. So there is no new entry
 * kind, no new lifecycle, nothing to renew (claim TTL is the subscription
 * TTL), and nothing for a lazy agent to forget. `subscribe_workspace` is NOT
 * repurposed — it keeps its honest-stub behavior and its name stays unburned.
 *
 * WHAT AN ACTIVE CLAIM AUTO-SUBSCRIBES ITS OWNER TO:
 *  1. ADDRESSED events — entries targeting this `agent_id` (surprises,
 *     including §3 declared-contract drift).
 *  2. FOOTPRINT-OVERLAP events — entries (claims, unclaimed-edits, outcomes)
 *     whose scope overlaps this claim's own footprint
 *     (paths ∪ symbols ∪ declared/observed contracts), matched LAZILY at read
 *     time.
 *
 * ZERO WRITE-TIME FAN-OUT: an append costs the same whether 0 or 100,000
 * claims exist, because matching happens at each reader's drain, scoped to
 * that reader's footprint — O(candidates) per drain, hard-capped. There is no
 * subscription store whose size tracks fleet size, because there are no
 * subscription records at all.
 *
 * NO CLAIM, NO DRAIN: an agent with no footprint has no relevance
 * neighborhood to scope a drain to, and polls explicitly instead
 * (`fab_list_active_work({near})`).
 *
 * CURSOR MODEL — stateless by construction. The caller supplies
 * `{epoch, since_seq}`; the response hands back `resume_seq` to pass next
 * time. Nothing server-side remembers who has read what (that store would be
 * exactly the subscription registry §5 refuses to build), so a caller that
 * does not echo `resume_seq` simply re-reads from its claim's own seq —
 * idempotent, capped, and safe. Entries are stable-identified by
 * `(claim_id, seq)` for client-side dedup.
 */

import { describeCursorGap, getBoardInfo, readClaimLog } from './local-store';
import type { BoardMeta, ClaimLogEntry } from './local-store';
import type { WorkClaim } from './types';

/** Default cap on entries in one `events` block — a burst never bloats a response. */
export const DEFAULT_EVENTS_CAP = 10;

/**
 * The `events` block piggybacked onto `fab_*` responses. ABSENT WHEN EMPTY:
 * zero noise for the common case (see `buildEventsBlock` returning undefined).
 */
export interface EventsBlock {
  /** Strictly capped, nearest/most-relevant first (addressed before overlap). */
  entries: DrainedEvent[];
  /** Pass back as `since_seq` next call to continue from here. */
  resume_seq: number;
  /** True when the backlog exceeded the cap — the rest is at `resume_seq`. */
  truncated: boolean;
  /** §7 cursor validity domain: a cursor from another epoch is meaningless. */
  epoch: string;
  /**
   * §7.2a DELIVERY FLOOR, never silence: set when the caller's cursor precedes
   * the board's `min_retained_seq` (compaction evicted events it never saw) or
   * when the caller's epoch no longer matches the board's.
   */
  gap_notice?: string;
}

/** One delivered log entry, trimmed to what a reader needs. */
export interface DrainedEvent {
  seq: number;
  claim_id: string;
  kind: ClaimLogEntry['kind'];
  agent_id: string;
  /** Why this reached you: addressed to you, or overlapping your footprint. */
  reason: 'addressed' | 'footprint_overlap';
  intent: string;
  paths: string[];
  symbols: string[];
  surprise?: ClaimLogEntry['surprise'];
  logged_at: string;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function pathsOverlap(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  if (!na || !nb) return false;
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/');
}

/**
 * This claim's relevance neighborhood: its paths, its symbols, and the paths
 * and names of every contract it declares or is observed producing (§3's
 * contracts are first-class footprint, not decoration).
 */
export function claimFootprint(claim: WorkClaim): { paths: string[]; tokens: Set<string> } {
  const paths = [...(claim.scope.paths ?? [])];
  const tokens = new Set<string>(claim.scope.symbols ?? []);
  for (const c of claim.produces ?? []) {
    tokens.add(c.name);
    if (c.path) paths.push(c.path);
  }
  for (const name of claim.consumes ?? []) tokens.add(name);
  return { paths, tokens };
}

function entryOverlapsFootprint(entry: ClaimLogEntry, fp: { paths: string[]; tokens: Set<string> }): boolean {
  for (const ep of entry.scope?.paths ?? []) {
    if (fp.paths.some((p) => pathsOverlap(p, ep))) return true;
  }
  for (const es of entry.scope?.symbols ?? []) {
    if (fp.tokens.has(es)) return true;
  }
  for (const c of entry.produces ?? []) {
    if (fp.tokens.has(c.name)) return true;
  }
  return false;
}

function toDrained(entry: ClaimLogEntry, reason: DrainedEvent['reason']): DrainedEvent {
  return {
    seq: entry.seq,
    claim_id: entry.claim_id,
    kind: entry.kind ?? 'claim',
    agent_id: entry.agent_id,
    reason,
    intent: entry.intent,
    paths: entry.scope?.paths ?? [],
    symbols: entry.scope?.symbols ?? [],
    ...(entry.surprise ? { surprise: entry.surprise } : {}),
    logged_at: entry.logged_at,
  };
}

export interface BuildEventsInput {
  log: ClaimLogEntry[];
  /** The owner's active claim — the subscription. No claim, no drain. */
  claim: WorkClaim;
  /** Exclusive lower bound. Defaults to the claim's own seq (its last write). */
  since_seq?: number;
  /** The epoch the caller's cursor belongs to; a mismatch is a gap, not silence. */
  since_epoch?: string;
  meta: Pick<BoardMeta, 'epoch' | 'min_retained_seq'>;
  cap?: number;
}

/**
 * PURE. Build the `events` block for one claim owner, or `undefined` when
 * there is nothing to say (absent-when-empty).
 *
 * Selection ranks ADDRESSED entries ahead of footprint-overlap ones, so a cap
 * never starves the events that name you personally. `resume_seq` is then set
 * to just below the lowest UNDELIVERED match, so nothing that was skipped for
 * the cap can be lost — at the cost of possibly re-delivering a high-seq
 * addressed entry on the next call, which is idempotent by `(claim_id, seq)`.
 */
export function buildEventsBlock(input: BuildEventsInput): EventsBlock | undefined {
  const cap = input.cap ?? DEFAULT_EVENTS_CAP;
  const { claim, log, meta } = input;
  const maxSeq = log.reduce((m, e) => Math.max(m, e.seq), 0);

  const epochMismatch = !!input.since_epoch && input.since_epoch !== meta.epoch;
  let sinceSeq = input.since_seq ?? claim.seq ?? 0;
  const notices: string[] = [];
  if (epochMismatch) {
    notices.push(
      `GAP: your cursor belongs to epoch "${input.since_epoch}" but this board's epoch is ` +
        `"${meta.epoch}" — the board was reset or restored. Your seq is meaningless here; ` +
        `re-list your neighborhood (fab_list_active_work) and resume from the returned resume_seq.`
    );
    sinceSeq = Math.max(0, meta.min_retained_seq - 1);
  }
  const gap = describeCursorGap(sinceSeq, meta);
  if (gap) notices.push(gap);

  const fp = claimFootprint(claim);
  const addressed: ClaimLogEntry[] = [];
  const overlapping: ClaimLogEntry[] = [];
  for (const entry of log) {
    if (entry.seq <= sinceSeq) continue;
    if (entry.agent_id === claim.agent_id && entry.kind !== 'surprise') continue; // your own writes are not news
    if (entry.claim_id === claim.claim_id) continue;
    if (entry.kind === 'surprise' && entry.agent_id === claim.agent_id) {
      addressed.push(entry);
      continue;
    }
    if (entry.kind === 'surprise') continue; // addressed to somebody else
    if (entryOverlapsFootprint(entry, fp)) overlapping.push(entry);
  }

  const ranked = [
    ...addressed.map((e) => ({ entry: e, reason: 'addressed' as const })),
    ...overlapping.map((e) => ({ entry: e, reason: 'footprint_overlap' as const })),
  ];
  const selected = ranked.slice(0, cap);
  const undelivered = ranked.slice(cap);
  const truncated = undelivered.length > 0;
  const resumeSeq = truncated
    ? Math.max(sinceSeq, Math.min(...undelivered.map((r) => r.entry.seq)) - 1)
    : Math.max(sinceSeq, maxSeq);

  if (selected.length === 0 && notices.length === 0) return undefined; // absent when empty

  return {
    entries: selected
      .sort((a, b) => (a.reason === b.reason ? a.entry.seq - b.entry.seq : a.reason === 'addressed' ? -1 : 1))
      .map((r) => toDrained(r.entry, r.reason)),
    resume_seq: resumeSeq,
    truncated,
    epoch: meta.epoch,
    ...(notices.length ? { gap_notice: notices.join(' ') } : {}),
  };
}

// ---------------------------------------------------------------------------
// IO wrapper (everything above this line is pure)
// ---------------------------------------------------------------------------

/**
 * Read-side convenience for the MCP/HTTP surfaces: load the board and build
 * the block for `claim`. Best-effort by contract — a drain failure must NEVER
 * fail the fabric call it piggybacks on, so every error degrades to "no
 * events block" (the same shape as "nothing to report").
 */
export async function drainEventsForClaim(
  workspaceId: string,
  claim: WorkClaim,
  opts: { since_seq?: number; since_epoch?: string; cap?: number } = {}
): Promise<EventsBlock | undefined> {
  try {
    const [log, meta] = await Promise.all([readClaimLog(workspaceId), getBoardInfo(workspaceId)]);
    return buildEventsBlock({ log, claim, meta, ...opts });
  } catch {
    return undefined;
  }
}
