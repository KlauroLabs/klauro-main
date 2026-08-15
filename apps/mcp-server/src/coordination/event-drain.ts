








































import { describeCursorGap, getBoardInfo, readClaimLog } from './local-store';
import type { BoardMeta, ClaimLogEntry } from './local-store';
import type { WorkClaim } from './types';


export const DEFAULT_EVENTS_CAP = 10;





export interface EventsBlock {

  entries: DrainedEvent[];

  resume_seq: number;

  truncated: boolean;

  epoch: string;





  gap_notice?: string;
}


export interface DrainedEvent {
  seq: number;
  claim_id: string;
  kind: ClaimLogEntry['kind'];
  agent_id: string;

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

  claim: WorkClaim;

  since_seq?: number;

  since_epoch?: string;
  meta: Pick<BoardMeta, 'epoch' | 'min_retained_seq'>;
  cap?: number;
}











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
    if (entry.agent_id === claim.agent_id && entry.kind !== 'surprise') continue;
    if (entry.claim_id === claim.claim_id) continue;
    if (entry.kind === 'surprise' && entry.agent_id === claim.agent_id) {
      addressed.push(entry);
      continue;
    }
    if (entry.kind === 'surprise') continue;
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

  if (selected.length === 0 && notices.length === 0) return undefined;

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
