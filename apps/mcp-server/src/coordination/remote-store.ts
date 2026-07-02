/**
 * REMOTE tier of the two-tier coordination store (§1.1 SPEC-COORDINATION-FABRIC.md).
 *
 * Cross-machine: propagates claims to (and reads presence/state from) the VPS
 * coordination service exposed by `remote-analyzer-service.ts`
 * (`POST /v1/coordination/claim`, `GET /v1/coordination/state`). The LOCAL
 * tier (`local-store.ts`) is authoritative for same-machine peers and a
 * write-through cache to this remote tier — a claim is appended locally FIRST
 * (instant, for same-host peers) and best-effort published to remote SECOND
 * (propagate, for other machines). A network failure publishing to remote
 * must never fail or block the local write (§1.1: "write-through cache").
 *
 * This module owns only the store/transport concerns for the remote side
 * (HTTP via the global `fetch`, merge/precedence of local+remote active sets).
 * Consistency/derivation logic (LWW by `seq`, TTL expiry) is delegated to the
 * already-built pure core in `./presence` — nothing here reimplements it.
 */

import { appendClaim, type ClaimLogEntry } from './local-store';
import { reduceClaimLog } from './presence';
import type { AgentPresence, WorkClaim } from './types';

/** Response shape from `POST /v1/coordination/claim` (see remote-analyzer-service.ts). */
export interface PublishClaimResult {
  claim_id: string;
  seq: number;
  verdict: 'granted' | 'conflict' | 'duplicate';
  kind?: string;
  evidence?: string[];
  with_claim?: {
    claim_id: string;
    agent_id: string;
    intent: string;
    scope: WorkClaim['scope'];
  };
}

/** Response shape from `GET /v1/coordination/state?workspace=&since=`. */
export interface RemoteState {
  workspace: string;
  max_seq: number;
  claims: WorkClaim[];
  presence: AgentPresence[];
}

/** Raised when a remote coordination HTTP call fails (network error or non-2xx). */
export class RemoteStoreError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'RemoteStoreError';
  }
}

function authHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function joinUrl(baseUrl: string, route: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${route}`;
}

/**
 * POST a claim to the remote coordination service. Throws `RemoteStoreError`
 * on network failure or a non-2xx response — callers (notably `syncClaim`)
 * decide whether that's fatal; the write-through contract requires it NOT be
 * fatal to the local write.
 */
export async function publishClaim(
  baseUrl: string,
  token: string | undefined,
  claim: WorkClaim
): Promise<PublishClaimResult> {
  let response: Response;
  try {
    response = await fetch(joinUrl(baseUrl, '/v1/coordination/claim'), {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({
        workspace: claim.workspace_id,
        agent_id: claim.agent_id,
        agent_kind: claim.agent_kind,
        intent: claim.intent,
        paths: claim.scope.paths,
        symbols: claim.scope.symbols,
        capability: claim.scope.capability,
        ttl_ms: claim.ttl_ms,
        base_commit: claim.base_commit,
        branch: claim.branch,
        claim_id: claim.claim_id,
      }),
    });
  } catch (err) {
    throw new RemoteStoreError(`publishClaim: network error POSTing to ${baseUrl}`, err);
  }
  if (!response.ok) {
    throw new RemoteStoreError(`publishClaim: remote responded ${response.status}`, await safeText(response));
  }
  return (await response.json()) as PublishClaimResult;
}

/**
 * GET the remote coordination state (active claims + presence) for a
 * workspace, optionally only entries newer than `since` (a `seq` watermark).
 * Throws `RemoteStoreError` on network failure or a non-2xx response.
 */
export async function fetchRemoteState(
  baseUrl: string,
  token: string | undefined,
  workspace: string,
  since?: number
): Promise<RemoteState> {
  const url = new URL(joinUrl(baseUrl, '/v1/coordination/state'));
  url.searchParams.set('workspace', workspace);
  if (since !== undefined) url.searchParams.set('since', String(since));

  let response: Response;
  try {
    response = await fetch(url.toString(), { method: 'GET', headers: authHeaders(token) });
  } catch (err) {
    throw new RemoteStoreError(`fetchRemoteState: network error GETing ${baseUrl}`, err);
  }
  if (!response.ok) {
    throw new RemoteStoreError(`fetchRemoteState: remote responded ${response.status}`, await safeText(response));
  }
  return (await response.json()) as RemoteState;
}

async function safeText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

/** Optional remote-tier config passed to `syncClaim`. Omit to write LOCAL only. */
export interface RemoteSyncOptions {
  baseUrl: string;
  token?: string;
}

export interface SyncClaimResult {
  /** The claim as appended to the LOCAL store (always succeeds or throws — never swallowed). */
  local: ClaimLogEntry;
  /** The remote publish result, if a remote tier was configured and the publish succeeded (either immediately or via an opportunistic flush of a prior queued entry — see `remoteQueued`). */
  remote?: PublishClaimResult;
  /** Set when a remote tier was configured but publishing failed — logged + queued, non-fatal. */
  remoteError?: string;
  /** True when the remote publish failed and was enqueued for retry (i.e. `remoteError` is set and the entry is now in the retry queue, not dropped). False if it was dropped (queue full / attempts exhausted). */
  remoteQueued?: boolean;
}

/**
 * §WS-K bounded in-memory retry queue for `syncClaim`'s remote-publish leg.
 * Local writes are always authoritative and never blocked by this queue —
 * it exists purely to catch up cross-machine propagation after a transient
 * remote outage without re-announcing failures forever or growing unbounded.
 *
 * Deterministic by design: capped size (drop-oldest on overflow, never
 * silently grows), capped attempts per entry (then dropped — the local store
 * remains the source of truth, so a permanently-unreachable remote never
 * loses data, only cross-machine visibility), and backoff is computed from
 * `attempts` (exponential) plus bounded jitter so retries of many entries
 * don't stampede the remote in lockstep.
 */
const RETRY_QUEUE_MAX_SIZE = 200;
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 30_000;
const RETRY_JITTER_MS = 250;

interface RetryQueueEntry {
  workspaceId: string;
  claim: ClaimLogEntry;
  remote: RemoteSyncOptions;
  attempts: number;
  /** Entry becomes eligible for retry once `Date.now() >= nextAttemptAt`. */
  nextAttemptAt: number;
}

/** Keyed by `${baseUrl}::${claim_id}` so re-queuing the same claim updates in place rather than duplicating. */
const retryQueue = new Map<string, RetryQueueEntry>();

function retryQueueKey(baseUrl: string, claimId: string): string {
  return `${baseUrl}::${claimId}`;
}

/** Exponential backoff with a cap and bounded jitter, keyed off the attempt count so far. */
function computeBackoffMs(attempts: number): number {
  const exponential = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
  const jitter = Math.random() * RETRY_JITTER_MS;
  return exponential + jitter;
}

/**
 * Enqueue a failed remote publish for retry. Bounded: if the queue is at
 * capacity, the OLDEST entry (by `nextAttemptAt`, a reasonable proxy for
 * insertion order since entries are scheduled forward from "now") is dropped
 * to make room — deterministic, never unbounded growth. Returns whether the
 * entry ended up queued (vs. dropped because attempts were already exhausted
 * or the queue is saturated even after eviction, which cannot happen given
 * drop-oldest always frees exactly one slot, but is handled defensively).
 */
function enqueueRetry(workspaceId: string, claim: ClaimLogEntry, remote: RemoteSyncOptions, priorAttempts: number): boolean {
  const attempts = priorAttempts + 1;
  if (attempts > RETRY_MAX_ATTEMPTS) return false;

  const key = retryQueueKey(remote.baseUrl, claim.claim_id);
  if (!retryQueue.has(key) && retryQueue.size >= RETRY_QUEUE_MAX_SIZE) {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [k, entry] of retryQueue) {
      if (entry.nextAttemptAt < oldestAt) {
        oldestAt = entry.nextAttemptAt;
        oldestKey = k;
      }
    }
    if (oldestKey) retryQueue.delete(oldestKey);
  }

  retryQueue.set(key, {
    workspaceId,
    claim,
    remote,
    attempts,
    nextAttemptAt: Date.now() + computeBackoffMs(attempts),
  });
  return true;
}

/**
 * Drain every due entry in the retry queue, attempting `publishClaim` for
 * each. Entries not yet due (still backing off) are left in place. A
 * successful publish removes the entry; a failure re-enqueues it with
 * incremented `attempts`/backoff (or drops it once `RETRY_MAX_ATTEMPTS` is
 * exceeded). Safe to call opportunistically and often — it's a no-op when
 * the queue is empty or nothing is due yet. Never throws.
 */
export async function flushRetryQueue(nowMs: number = Date.now()): Promise<{ flushed: number; requeued: number; dropped: number }> {
  let flushed = 0;
  let requeued = 0;
  let dropped = 0;

  const due = [...retryQueue.entries()].filter(([, entry]) => entry.nextAttemptAt <= nowMs);
  for (const [key, entry] of due) {
    try {
      await publishClaim(entry.remote.baseUrl, entry.remote.token, entry.claim);
      retryQueue.delete(key);
      flushed += 1;
    } catch {
      retryQueue.delete(key);
      const requeuedOk = enqueueRetry(entry.workspaceId, entry.claim, entry.remote, entry.attempts);
      if (requeuedOk) requeued += 1;
      else dropped += 1;
    }
  }

  return { flushed, requeued, dropped };
}

/** Current retry-queue size (for tests/diagnostics). */
export function getRetryQueueSize(): number {
  return retryQueue.size;
}

/** Clears the retry queue (test-only helper — avoids cross-test bleed since the queue is module-level state). */
export function __resetRetryQueueForTests(): void {
  retryQueue.clear();
}

/**
 * Write-through: append `claim` to the LOCAL store FIRST (instant, authoritative
 * for same-host peers), then best-effort publish to the REMOTE tier if
 * `remote` options are supplied. A remote network failure is caught, logged,
 * and enqueued on the bounded retry queue (§WS-K) — it never throws and never
 * blocks/undoes the local write (§1.1 invariant).
 *
 * Every call also opportunistically drains any due entries already in the
 * retry queue before attempting its own publish (best-effort, failures there
 * are swallowed by `flushRetryQueue` itself) — so a run of successful syncs
 * after an outage naturally catches the backlog back up without a separate
 * poller. The local store is always the source of truth for same-machine
 * peers regardless of remote reachability, so no data is ever lost — only
 * cross-machine propagation is delayed until the queue drains or a claim's
 * attempts are exhausted.
 */
export async function syncClaim(
  workspaceId: string,
  claim: Omit<WorkClaim, 'seq'> & { seq?: number },
  remote?: RemoteSyncOptions
): Promise<SyncClaimResult> {
  const local = await appendClaim(workspaceId, claim);

  if (!remote) {
    return { local };
  }

  // Opportunistic drain: catch up any backlog before adding to it. Best-effort
  // and non-blocking in the sense that its own failures never propagate here.
  await flushRetryQueue();

  try {
    const result = await publishClaim(remote.baseUrl, remote.token, local);
    return { local, remote: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const queued = enqueueRetry(workspaceId, local, remote, 0);
    // eslint-disable-next-line no-console
    console.error(
      `[coordination/remote-store] syncClaim: remote publish failed, local write kept (${message})` +
        (queued ? ' — queued for retry' : ' — retry queue full/exhausted, dropped')
    );
    return { local, remoteError: message, remoteQueued: queued };
  }
}

/**
 * Union the local active-claim set with a remote-fetched active-claim set,
 * deduping by `claim_id` with last-writer-wins by `seq` (reusing the same
 * reducer `local-store.ts` uses for its own log, so the merge rule is
 * identical whether a claim came from disk or from the network).
 */
export function mergeRemotePeers(localActive: WorkClaim[], remoteState: RemoteState | undefined): WorkClaim[] {
  const combined = [...localActive, ...(remoteState?.claims ?? [])];
  return reduceClaimLog(combined).filter((c) => c.status === 'active');
}
