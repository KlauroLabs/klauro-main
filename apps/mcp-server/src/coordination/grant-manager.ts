/**
 * ENFORCED, symbol-level grant arbitration (Coordination Fabric v2, §WS-C+).
 *
 * Where `arbiter.ts` + `local-store.ts` only DETECT conflicts (advisory
 * `checkEditLock`), this module ENFORCES them: an agent must hold a `Grant`
 * before it may edit a scope, and the invariant this module guarantees is:
 *
 *   at most ONE active grant per symbol (or per overlapping path) at a time.
 *
 * Persistence: grants are NOT a new store. They are `WorkClaim` records
 * appended to the same same-machine claim log local-store.ts already owns
 * (`~/.klauro/coordination/<workspace_id>/claims.jsonl`), tagged via a
 * JSON-encoded `intent` marker (`{"__grant__": {...}}`) so `arbitrate()`'s
 * normal duplicate-work path never confuses a grant claim for a capability
 * claim, and so `deriveActiveClaims` (LWW + TTL expiry, from presence.ts)
 * gives grant expiry for free — no background timer needed, expiry is
 * computed at read time exactly like the rest of the fabric.
 *
 * A QUEUED request is persisted the same way (also a claim, `status:
 * 'active'`, `ttl_ms` effectively infinite until served) but its marker kind
 * is `'queued'` instead of `'granted'`, so it is excluded from the "active
 * grants" projection used for overlap checks and is instead carried in a
 * separate FIFO queue projection. This keeps everything on the one
 * crash-safe, lock-guarded append path `local-store.ts` already provides
 * (`appendClaim` / `withLock`'s stale-lock reclaim) — no new lock, no new
 * file format.
 */

import { arbitrate } from './arbiter';
import { readClaimLog, withWorkspaceLock, type ClaimLogEntry } from './local-store';
import { deriveActiveClaims, isExpired, reduceClaimLog } from './presence';
import type { AgentKind, ConceptualCoordinate, ConflictKind, WorkClaim } from './types';

export type GrantVerdict = 'granted' | 'queued' | 'denied';

export interface GrantRequest {
  workspace_id: string;
  agent_id: string;
  agent_kind: AgentKind;
  scope: { repo: string; paths: string[]; symbols: string[]; capability?: string; concept?: ConceptualCoordinate };
  intent: string;
  ttl_ms?: number;
}

export interface GrantConflict {
  holder_agent_id: string;
  overlapping_symbols: string[];
  overlapping_paths: string[];
  kind: ConflictKind;
}

export interface GrantResult {
  verdict: GrantVerdict;
  grant_id?: string; // set when granted
  lease_expires_at?: string; // set when granted
  queue_position?: number; // set when queued (1-based, behind the holder)
  conflict?: GrantConflict; // set when queued/denied
  redirect_hint?: string; // optional: human hint for non-conflicting work
}

export interface ActiveGrant {
  grant_id: string;
  agent_id: string;
  scope: GrantRequest['scope'];
  granted_at: string;
  lease_expires_at: string;
}

const DEFAULT_GRANT_TTL_MS = 5 * 60 * 1000; // 5 minutes, matches local-store's edit-lock default.
const QUEUE_TTL_MS = 24 * 60 * 60 * 1000; // queued entries don't self-expire on any practical timescale.

/** JSON marker embedded in a grant claim's `intent` field (kept string-typed on WorkClaim). */
interface GrantMarker {
  __grant__: {
    kind: 'granted' | 'queued';
    grant_id: string;
    /** Original caller intent string, preserved for attribution/debugging. */
    intent: string;
    /** For queued entries: ISO time the request was queued (FIFO ordering key). */
    queued_at?: string;
  };
}

function encodeIntent(marker: GrantMarker): string {
  return JSON.stringify(marker);
}

function decodeGrantMarker(intent: string): GrantMarker['__grant__'] | undefined {
  try {
    const parsed = JSON.parse(intent);
    if (parsed && typeof parsed === 'object' && parsed.__grant__) {
      return parsed.__grant__ as GrantMarker['__grant__'];
    }
  } catch {
    // not a grant-manager claim (e.g. a plain edit-lock or capability claim) — ignore.
  }
  return undefined;
}

function newGrantId(): string {
  return `grant_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function grantClaimId(workspaceId: string, grantId: string): string {
  return `grant:${workspaceId}:${grantId}`;
}

/**
 * All non-expired grant-manager claims (both granted and queued kinds),
 * LWW-reduced. PURE — operates on an already-read `log` (typically the
 * lock-held snapshot from `withWorkspaceLock`) rather than reading from disk
 * itself, so callers can derive this repeatedly against one consistent
 * in-memory snapshot inside one atomic critical section.
 */
function grantClaimsFromLog(
  log: ClaimLogEntry[],
  workspaceId: string,
  nowMs: number
): Array<{ claim: WorkClaim; marker: GrantMarker['__grant__'] }> {
  const active = deriveActiveClaims(log, nowMs).filter((c) => c.workspace_id === workspaceId);
  const out: Array<{ claim: WorkClaim; marker: GrantMarker['__grant__'] }> = [];
  for (const claim of active) {
    const marker = decodeGrantMarker(claim.intent);
    if (marker) out.push({ claim, marker });
  }
  return out;
}

/** Currently-active (granted, non-expired) grants, as `WorkClaim`s + markers. Pure. */
function activeGrantClaimsFromLog(
  log: ClaimLogEntry[],
  workspaceId: string,
  nowMs: number
): Array<{ claim: WorkClaim; marker: GrantMarker['__grant__'] }> {
  return grantClaimsFromLog(log, workspaceId, nowMs).filter((e) => e.marker.kind === 'granted');
}

/** Currently-queued grant requests, ordered FIFO by `queued_at`. Pure. */
function queuedGrantClaimsFromLog(
  log: ClaimLogEntry[],
  workspaceId: string,
  nowMs: number
): Array<{ claim: WorkClaim; marker: GrantMarker['__grant__'] }> {
  return grantClaimsFromLog(log, workspaceId, nowMs)
    .filter((e) => e.marker.kind === 'queued')
    .sort((a, b) => Date.parse(a.marker.queued_at ?? a.claim.created_at) - Date.parse(b.marker.queued_at ?? b.claim.created_at));
}

/** Non-lock-held convenience wrappers for read-only callers (getGrants after advanceQueue already ran). */
async function readActiveGrantClaims(
  workspaceId: string,
  nowMs: number
): Promise<Array<{ claim: WorkClaim; marker: GrantMarker['__grant__'] }>> {
  const log = await readClaimLog(workspaceId);
  return activeGrantClaimsFromLog(log, workspaceId, nowMs);
}

async function readQueuedGrantClaims(
  workspaceId: string,
  nowMs: number
): Promise<Array<{ claim: WorkClaim; marker: GrantMarker['__grant__'] }>> {
  const log = await readClaimLog(workspaceId);
  return queuedGrantClaimsFromLog(log, workspaceId, nowMs);
}

function toActiveGrant(claim: WorkClaim, marker: GrantMarker['__grant__']): ActiveGrant {
  const leaseMs = Date.parse(claim.heartbeat_at) + claim.ttl_ms;
  return {
    grant_id: marker.grant_id,
    agent_id: claim.agent_id,
    scope: claim.scope,
    granted_at: claim.created_at,
    lease_expires_at: new Date(leaseMs).toISOString(),
  };
}

/** Build a synthetic `WorkClaim` (arbiter input shape) from a scope, for overlap checks. */
function scopeAsClaim(id: string, agentId: string, scope: GrantRequest['scope']): WorkClaim {
  const now = new Date().toISOString();
  return {
    claim_id: id,
    seq: 0,
    workspace_id: '',
    agent_id: agentId,
    agent_kind: 'other',
    scope,
    intent: '',
    status: 'active',
    created_at: now,
    ttl_ms: DEFAULT_GRANT_TTL_MS,
    heartbeat_at: now,
  };
}

/** Symbol/path overlap between two scopes (mirrors arbiter.ts's own path-prefix rule). */
function scopesOverlap(
  a: GrantRequest['scope'],
  b: GrantRequest['scope']
): { symbols: string[]; paths: string[] } | undefined {
  const symbols = a.symbols.filter((s) => b.symbols.includes(s));
  const paths: string[] = [];
  for (const p of a.paths) {
    for (const op of b.paths) {
      if (pathsOverlap(p, op)) paths.push(op);
    }
  }
  if (symbols.length === 0 && paths.length === 0) return undefined;
  return { symbols, paths: [...new Set(paths)] };
}

function normalizePath(p: string): string {
  return p.replace(/\/+$/, '');
}

function pathsOverlap(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/');
}

/** Find the first active grant whose scope conflicts with `scope`, if any. */
function findConflictingActiveGrant(
  scope: GrantRequest['scope'],
  activeGrants: Array<{ claim: WorkClaim; marker: GrantMarker['__grant__'] }>,
  excludeAgentId?: string
): { holder: WorkClaim; overlap: { symbols: string[]; paths: string[] } } | undefined {
  for (const { claim } of activeGrants) {
    if (excludeAgentId && claim.agent_id === excludeAgentId) continue;
    const overlap = scopesOverlap(scope, claim.scope);
    if (overlap) return { holder: claim, overlap };
  }
  return undefined;
}

function conflictKindFor(overlap: { symbols: string[]; paths: string[] }): ConflictKind {
  return overlap.symbols.length > 0 ? 'symbol' : 'path';
}

/**
 * Request a grant for a scope. Uses `arbitrate()` (same overlap semantics the
 * rest of the fabric relies on: capability duplicate, path-prefix, symbol-set)
 * against the currently ACTIVE grant set.
 *
 * - No conflict           → GRANT immediately.
 * - Conflict, same scope+agent (duplicate) → return the existing grant (idempotent).
 * - Conflict, different agent → QUEUE (FIFO) behind the holder.
 *
 * CONCURRENCY: the entire read-active-set + decide + append sequence runs
 * inside ONE `withWorkspaceLock` critical section. Previously each step
 * (`advanceQueue`, `readActiveGrantClaims`, the final `appendClaim`) took its
 * own independent lock, so two `requestGrant` calls for overlapping scope
 * could each complete their "is there a conflict?" read before either had
 * appended anything — both would see no conflict and both would be granted,
 * violating the "at most one active grant per symbol" invariant this module
 * exists to enforce. Reproduced 100/100 in a concurrent-race test before this
 * fix (see grant-manager.test.ts "concurrent requestGrant for overlapping
 * scope never double-grants").
 */
export async function requestGrant(req: GrantRequest): Promise<GrantResult> {
  return withWorkspaceLock(req.workspace_id, async ({ log, append }) => {
    const nowMs = Date.now();

    // Reconcile first: a holder's lease may have lapsed since the last release
    // or heartbeat with nobody calling releaseGrant (expiry is read-time-only,
    // per spec — no background timer). Advancing here means a queued agent is
    // promoted the moment *anyone* next looks, not only on an explicit release.
    // Runs against the SAME in-lock `log`/`append` so promotions from this
    // reconciliation are visible to the conflict check immediately below.
    await advanceQueueLocked(req.workspace_id, log, append, nowMs);

    let activeGrants = activeGrantClaimsFromLog(log, req.workspace_id, nowMs);

    // Idempotent duplicate: same agent already holds a grant with the identical scope.
    const existingSameAgent = activeGrants.find(
      (e) =>
        e.claim.agent_id === req.agent_id &&
        e.claim.scope.repo === req.scope.repo &&
        sameStringSet(e.claim.scope.paths, req.scope.paths) &&
        sameStringSet(e.claim.scope.symbols, req.scope.symbols)
    );
    if (existingSameAgent) {
      return {
        verdict: 'granted',
        grant_id: existingSameAgent.marker.grant_id,
        lease_expires_at: toActiveGrant(existingSameAgent.claim, existingSameAgent.marker)
          .lease_expires_at,
      };
    }

    // Use the shared arbiter for capability-duplicate detection; symbol/path overlap
    // is checked directly below since arbiter.arbitrate needs a WorkClaim[] and
    // we want conflict details keyed to grants (not generic claims).
    const asClaim = scopeAsClaim('__grant_probe__', req.agent_id, req.scope);
    const asClaims = activeGrants.map((e) => e.claim);
    const arbResult = arbitrate(asClaim, asClaims, [], []);
    void arbResult; // capability-path is not used by grants today (no capability dedupe requested); kept for parity/future use.

    const conflicting = findConflictingActiveGrant(req.scope, activeGrants, req.agent_id);
    if (!conflicting) {
      const grantId = newGrantId();
      const now = new Date(nowMs).toISOString();
      const ttlMs = req.ttl_ms ?? DEFAULT_GRANT_TTL_MS;
      await append({
        claim_id: grantClaimId(req.workspace_id, grantId),
        workspace_id: req.workspace_id,
        agent_id: req.agent_id,
        agent_kind: req.agent_kind,
        scope: req.scope,
        intent: encodeIntent({ __grant__: { kind: 'granted', grant_id: grantId, intent: req.intent } }),
        status: 'active',
        created_at: now,
        ttl_ms: ttlMs,
        heartbeat_at: now,
      });
      return {
        verdict: 'granted',
        grant_id: grantId,
        lease_expires_at: new Date(nowMs + ttlMs).toISOString(),
      };
    }

    // Conflict with another agent's active grant → queue behind the holder.
    const queued = queuedGrantClaimsFromLog(log, req.workspace_id, nowMs);
    const grantId = newGrantId();
    const queuedAt = new Date(nowMs).toISOString();
    await append({
      claim_id: grantClaimId(req.workspace_id, grantId),
      workspace_id: req.workspace_id,
      agent_id: req.agent_id,
      agent_kind: req.agent_kind,
      scope: req.scope,
      intent: encodeIntent({
        __grant__: { kind: 'queued', grant_id: grantId, intent: req.intent, queued_at: queuedAt },
      }),
      status: 'active',
      created_at: queuedAt,
      ttl_ms: QUEUE_TTL_MS,
      heartbeat_at: queuedAt,
    });

    const position =
      queued.filter((e) => Date.parse(e.marker.queued_at ?? e.claim.created_at) < nowMs).length + 1;

    return {
      verdict: 'queued',
      queue_position: position,
      conflict: {
        holder_agent_id: conflicting.holder.agent_id,
        overlapping_symbols: conflicting.overlap.symbols,
        overlapping_paths: conflicting.overlap.paths,
        kind: conflictKindFor(conflicting.overlap),
      },
      redirect_hint:
        'Scope conflicts with an in-progress grant; consider disjoint symbols/paths, or wait for the queue to advance.',
    };
  });
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((x) => setB.has(x));
}

/**
 * Release a grant (or a still-queued request) held by `agentId`. Marks the
 * underlying claim `released`, then advances the queue: the earliest queued
 * request whose scope no longer conflicts with any remaining active grant is
 * promoted to `granted` (its claim is superseded by a new granted-kind claim
 * under the SAME grant_id, so its `grant_id` stays stable for the caller).
 *
 * CONCURRENCY: release + queue-advancement run inside ONE `withWorkspaceLock`
 * critical section (same reasoning as `requestGrant` above) — a concurrent
 * `requestGrant` cannot interleave between "mark released" and "promote the
 * next queued entry", which would otherwise risk a promoted grant briefly
 * appearing to conflict with a fresh request that read between the two steps.
 */
export async function releaseGrant(
  workspaceId: string,
  agentId: string,
  grantId: string
): Promise<void> {
  await withWorkspaceLock(workspaceId, async ({ log, append }) => {
    const nowMs = Date.now();
    const prior = [...log]
      .reverse()
      .find((e) => e.claim_id === grantClaimId(workspaceId, grantId) && e.agent_id === agentId);
    if (!prior) return; // nothing to release (already gone/unknown grant).

    const now = new Date(nowMs).toISOString();
    await append({
      claim_id: grantClaimId(workspaceId, grantId),
      workspace_id: workspaceId,
      agent_id: agentId,
      agent_kind: prior.agent_kind,
      scope: prior.scope,
      intent: prior.intent,
      status: 'released',
      created_at: prior.created_at,
      ttl_ms: prior.ttl_ms,
      heartbeat_at: now,
    });

    await advanceQueueLocked(workspaceId, log, append, nowMs);
  });
}

/**
 * Promote queued requests (FIFO) whose scope no longer conflicts with any
 * remaining active grant. PURE side-effecting core: operates against the
 * in-lock `log`/`append` passed by the caller's `withWorkspaceLock` critical
 * section — this must NEVER be called outside a lock, since it reads-then-
 * decides-then-appends and that sequence is exactly what must stay atomic.
 * May promote more than one queued entry per call if multiple are
 * simultaneously conflict-free.
 */
async function advanceQueueLocked(
  workspaceId: string,
  log: ClaimLogEntry[],
  append: (claim: Omit<WorkClaim, 'seq'> & { seq?: number }) => Promise<ClaimLogEntry>,
  nowMs: number
): Promise<void> {
  let activeGrants = activeGrantClaimsFromLog(log, workspaceId, nowMs);
  const queued = queuedGrantClaimsFromLog(log, workspaceId, nowMs);

  for (const entry of queued) {
    // No agent-exclusion here: the invariant is "at most one active grant per
    // symbol/path", full stop. A second queued request from the SAME agent
    // for the same symbol (e.g. it queued twice before either was served)
    // must NOT be promoted just because it doesn't conflict with "someone
    // else's" grant — it would create two simultaneous active grants for one
    // agent on one symbol, which is exactly what the invariant forbids.
    const conflict = findConflictingActiveGrant(entry.claim.scope, activeGrants);
    if (conflict) continue; // still blocked; stays queued (FIFO order preserved by loop order).

    // Promote: same grant_id, kind flips to 'granted', fresh lease starts now.
    const now = new Date().toISOString();
    const ttlMs = entry.claim.ttl_ms === QUEUE_TTL_MS ? DEFAULT_GRANT_TTL_MS : entry.claim.ttl_ms;
    const granted = await append({
      claim_id: entry.claim.claim_id,
      workspace_id: workspaceId,
      agent_id: entry.claim.agent_id,
      agent_kind: entry.claim.agent_kind,
      scope: entry.claim.scope,
      intent: encodeIntent({
        __grant__: { kind: 'granted', grant_id: entry.marker.grant_id, intent: entry.marker.intent },
      }),
      status: 'active',
      created_at: now,
      ttl_ms: ttlMs,
      heartbeat_at: now,
    });
    activeGrants = [...activeGrants, { claim: granted, marker: decodeGrantMarker(granted.intent)! }];
  }
}

/**
 * Extend a grant's lease to now+ttl (heartbeat). Returns `ok:false` if the
 * grant no longer exists (released, expired, or never granted — e.g. still
 * queued).
 */
export async function heartbeatGrant(
  workspaceId: string,
  grantId: string
): Promise<{ ok: boolean; lease_expires_at?: string }> {
  return withWorkspaceLock(workspaceId, async ({ log, append }) => {
    const nowMs = Date.now();
    const activeGrants = activeGrantClaimsFromLog(log, workspaceId, nowMs);
    const found = activeGrants.find((e) => e.marker.grant_id === grantId);
    if (!found) return { ok: false };

    const now = new Date(nowMs).toISOString();
    await append({
      claim_id: found.claim.claim_id,
      workspace_id: workspaceId,
      agent_id: found.claim.agent_id,
      agent_kind: found.claim.agent_kind,
      scope: found.claim.scope,
      intent: found.claim.intent,
      status: 'active',
      created_at: found.claim.created_at,
      ttl_ms: found.claim.ttl_ms,
      heartbeat_at: now,
    });
    return { ok: true, lease_expires_at: new Date(nowMs + found.claim.ttl_ms).toISOString() };
  });
}

/** Current active + queued grants for a workspace (read-only projection). */
export async function getGrants(
  workspaceId: string
): Promise<{
  active: ActiveGrant[];
  queued: Array<{ agent_id: string; scope: GrantRequest['scope']; queued_at: string }>;
}> {
  // Reconcile lapsed leases against the queue before reporting, same reasoning
  // as requestGrant: expiry is read-time-only, so a poller must trigger the
  // same advancement a fresh request would. Runs its own atomic critical
  // section (read + promote); the subsequent plain read below is then
  // consistent because promotions have already been durably appended.
  await withWorkspaceLock(workspaceId, async ({ log, append }) => {
    await advanceQueueLocked(workspaceId, log, append, Date.now());
  });

  const nowMs = Date.now();
  const activeGrants = await readActiveGrantClaims(workspaceId, nowMs);
  const queuedGrants = await readQueuedGrantClaims(workspaceId, nowMs);
  return {
    active: activeGrants.map((e) => toActiveGrant(e.claim, e.marker)),
    queued: queuedGrants.map((e) => ({
      agent_id: e.claim.agent_id,
      scope: e.claim.scope,
      queued_at: e.marker.queued_at ?? e.claim.created_at,
    })),
  };
}

// Re-exported so tests can assert on decode without duplicating the marker shape.
export const __internal = { decodeGrantMarker, reduceClaimLog, isExpired };
