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

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { appendClaim, getBoardInfo, getStoreDir, readClaimLog, type ClaimLogEntry } from './local-store';
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
  /** Board epoch (durable-board protocol) — a cursor from a different epoch must reset. Absent from pre-epoch servers. */
  epoch?: string;
  /** Compaction retention floor — a cursor below it has MISSED events (see `gap`). */
  min_retained_seq?: number;
  /** Explicit gap notice when the caller's `since` cursor is below `min_retained_seq` — never silence. */
  gap?: string;
}

/**
 * Client-side cursor reconciliation for `{epoch, seq}` cursors over a remote
 * board (durable-board protocol): the cursor RESETS when the board's epoch
 * changed (board wiped/recreated — the old seq domain is meaningless) OR when
 * the cursor is ahead of the board's max_seq (a board reset without an epoch
 * bump, e.g. a pre-epoch server; a cursor "in the future" would otherwise see
 * nothing forever — the observed 2026-07-21 failure mode).
 */
export function reconcileRemoteCursor(
  stored: { epoch?: string; seq: number } | undefined,
  board: { epoch?: string; max_seq: number }
): { seq: number; epoch?: string; reset: boolean; reason?: string } {
  if (!stored) return { seq: 0, epoch: board.epoch, reset: false };
  if (stored.epoch && board.epoch && stored.epoch !== board.epoch) {
    return { seq: 0, epoch: board.epoch, reset: true, reason: `board epoch changed (${stored.epoch} -> ${board.epoch}) — cursor reset to 0` };
  }
  if (stored.seq > board.max_seq) {
    return { seq: 0, epoch: board.epoch, reset: true, reason: `cursor ${stored.seq} is ahead of board max_seq ${board.max_seq} (board was reset) — cursor reset to 0` };
  }
  return { seq: stored.seq, epoch: board.epoch ?? stored.epoch, reset: false };
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
  claim: WorkClaim & { kind?: ClaimLogEntry['kind'] }
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
        // Writer-owned version + lifecycle status ECHOED VERBATIM to the
        // receiver (durable-board protocol): the remote board must merge this
        // entry by the writer's own per-claim version, never by its own
        // arrival seq, and must honor a 'released' status (previously status
        // never crossed the wire, so a write-through of a release entry
        // re-appeared remotely as an ACTIVE claim). Old servers ignore the
        // extra fields — backward compatible.
        status: claim.status,
        version: claim.version,
        kind: claim.kind,
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
  /** Set when a remote tier was configured but publishing failed — logged, non-fatal; the DURABLE sync cursor resumes it on any later call. */
  remoteError?: string;
  /** True when the remote publish failed and the entry remains ahead of the durable sync cursor (it WILL be re-published — resumable across restarts and outages of any length; nothing is dropped). */
  remoteQueued?: boolean;
}

/**
 * DURABLE remote sync (Coordination Engine wave 1) — replaces the former §WS-K
 * bounded in-memory retry queue (which was lost on process exit, dropped the
 * oldest entry past 200, gave up after ~5 attempts, AND could flush an OLD
 * claim version after a NEWER one had already landed remotely, resurrecting
 * stale scope). The local append-only claim log is already the durable record,
 * so the retry state collapses to ONE number: a per-(workspace, baseUrl) sync
 * cursor (`last_acked_seq`) persisted beside the log in `remote-sync.json`.
 * Publish everything after the cursor, in seq order — resumable across process
 * restarts and outages of ANY length, nothing ever dropped.
 *
 * Version discipline on the flush path: an entry is SKIPPED (cursor still
 * advances past it) when the log already holds a HIGHER writer-owned version
 * for the same claim_id — publishing it could only resurrect a superseded
 * state; the newer entry (later in this same flush, or already remote) is the
 * truth. LEGACY entries without `version` are published as-is (seq order alone
 * protects them, matching the documented pre-version behavior).
 *
 * Coordination entries only: `kind: 'surprise'` / `'unclaimed-edit'` events are
 * locally-addressed and are not published (the cursor advances past them);
 * unrelated telemetry queues are untouched by design.
 *
 * In-memory backoff (not durability): after a failed flush the base URL is
 * marked not-due for an exponentially growing window so opportunistic flushes
 * during an outage don't hammer the remote. The DURABILITY lives in the
 * cursor file; the backoff state can be lost freely.
 */
interface SyncCursorFile {
  cursors: Record<string, { epoch?: string; last_acked_seq: number }>;
}

function syncCursorPath(workspaceId: string): string {
  return path.join(getStoreDir(workspaceId), 'remote-sync.json');
}

async function readSyncCursors(workspaceId: string): Promise<SyncCursorFile> {
  try {
    const raw = await fsp.readFile(syncCursorPath(workspaceId), 'utf8');
    const parsed = JSON.parse(raw) as SyncCursorFile;
    if (parsed && typeof parsed === 'object' && parsed.cursors && typeof parsed.cursors === 'object') return parsed;
  } catch {
    // absent/corrupt — start over from seq 0 (safe: re-publishing is idempotent
    // under LWW-by-version on the receiver).
  }
  return { cursors: {} };
}

async function writeSyncCursor(
  workspaceId: string,
  baseUrl: string,
  cursor: { epoch?: string; last_acked_seq: number }
): Promise<void> {
  const file = await readSyncCursors(workspaceId);
  file.cursors[baseUrl] = cursor;
  const target = syncCursorPath(workspaceId);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, target);
}

const FLUSH_BACKOFF_BASE_MS = 500;
const FLUSH_BACKOFF_MAX_MS = 30_000;
const flushBackoff = new Map<string, { attempts: number; nextAttemptAt: number }>();

function backoffKey(workspaceId: string, baseUrl: string): string {
  return `${workspaceId}::${baseUrl}`;
}

export interface RemoteSyncFlushResult {
  /** Entries successfully published this call. */
  published: number;
  /** Entries the cursor advanced past WITHOUT publishing (superseded version, or a local-only event kind). */
  skipped: number;
  /** Entries still ahead of the cursor after this call (0 unless a failure stopped the flush). */
  pending: number;
  /** The cursor after this call. */
  last_acked_seq: number;
  /** Set when the flush stopped early on a publish failure — the cursor holds; the next call resumes. */
  error?: string;
  /** Publish results by local seq, for callers that need the outcome of a specific entry (syncClaim). */
  results: Map<number, PublishClaimResult>;
}

/**
 * Publish every coordination entry after the durable sync cursor for
 * `(workspaceId, remote.baseUrl)`, in seq order. Safe to call opportunistically
 * and often: no-op when nothing is pending or the backoff window from a prior
 * failure hasn't elapsed. Never throws. Board-epoch aware: if the local board's
 * epoch differs from the cursor's stored epoch (board recreated), or the cursor
 * is ahead of the log's max seq, the cursor RESETS and the current state is
 * re-published (idempotent under receiver-side LWW-by-version).
 */
export async function flushRemoteSync(
  workspaceId: string,
  remote: RemoteSyncOptions,
  nowMs: number = Date.now()
): Promise<RemoteSyncFlushResult> {
  const results = new Map<number, PublishClaimResult>();
  const bk = backoffKey(workspaceId, remote.baseUrl);
  const backoff = flushBackoff.get(bk);
  if (backoff && nowMs < backoff.nextAttemptAt) {
    return { published: 0, skipped: 0, pending: -1, last_acked_seq: -1, error: 'backing off after a prior failure', results };
  }

  const board = await getBoardInfo(workspaceId);
  const log = await readClaimLog(workspaceId);
  const maxSeq = log.reduce((max, e) => Math.max(max, e.seq), 0);

  const file = await readSyncCursors(workspaceId);
  const stored = file.cursors[remote.baseUrl];
  const reconciled = reconcileRemoteCursor(
    stored ? { epoch: stored.epoch, seq: stored.last_acked_seq } : undefined,
    { epoch: board.epoch, max_seq: maxSeq }
  );
  let lastAcked = reconciled.seq;

  // Highest writer-owned version per claim_id across the WHOLE log — the
  // stale-flush guard: never publish an entry a newer version supersedes.
  const latestVersion = new Map<string, number>();
  for (const e of log) {
    if (typeof e.version !== 'number') continue;
    const prior = latestVersion.get(e.claim_id);
    if (prior === undefined || e.version > prior) latestVersion.set(e.claim_id, e.version);
  }

  const pendingEntries = log.filter((e) => e.seq > lastAcked).sort((a, b) => a.seq - b.seq);
  let published = 0;
  let skipped = 0;
  let error: string | undefined;

  for (const entry of pendingEntries) {
    const isLocalOnlyEvent = entry.kind === 'surprise' || entry.kind === 'unclaimed-edit';
    const newest = latestVersion.get(entry.claim_id);
    const superseded = typeof entry.version === 'number' && newest !== undefined && entry.version < newest;
    if (isLocalOnlyEvent || superseded) {
      skipped += 1;
      lastAcked = entry.seq;
      continue;
    }
    try {
      const result = await publishClaim(remote.baseUrl, remote.token, entry);
      results.set(entry.seq, result);
      published += 1;
      lastAcked = entry.seq;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      break; // hold the cursor here; the next call resumes from this entry.
    }
  }

  await writeSyncCursor(workspaceId, remote.baseUrl, { epoch: board.epoch, last_acked_seq: lastAcked });

  if (error) {
    const attempts = (backoff?.attempts ?? 0) + 1;
    flushBackoff.set(bk, {
      attempts,
      nextAttemptAt: nowMs + Math.min(FLUSH_BACKOFF_MAX_MS, FLUSH_BACKOFF_BASE_MS * 2 ** (attempts - 1)) + Math.random() * 250,
    });
  } else {
    flushBackoff.delete(bk);
  }

  const pending = log.filter((e) => e.seq > lastAcked).length;
  return { published, skipped, pending, last_acked_seq: lastAcked, error, results };
}

/** Test-only: clears the in-memory flush backoff (the durable cursor file is per-test-dir anyway). */
export function __resetRemoteSyncForTests(): void {
  flushBackoff.clear();
}

/**
 * Write-through: append `claim` to the LOCAL store FIRST (instant, authoritative
 * for same-host peers), then publish through the DURABLE sync cursor if
 * `remote` options are supplied — one `flushRemoteSync` pass that first drains
 * any backlog (in seq order, so an outage's claims land before this one) and
 * then this entry itself. A remote failure is caught and logged; the entry
 * stays ahead of the cursor and WILL be re-published on any later call, across
 * restarts and outages of any length (§1.1 invariant: the remote leg never
 * throws and never blocks/undoes the local write; nothing is ever dropped).
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

  const flush = await flushRemoteSync(workspaceId, remote);
  const own = flush.results.get(local.seq);
  if (own) return { local, remote: own };

  const message = flush.error ?? 'publish deferred (superseded by a newer version, or backlog still draining)';
  if (flush.error) {
    // eslint-disable-next-line no-console
    console.error(
      `[coordination/remote-store] syncClaim: remote publish failed, local write kept (${message}) — ` +
        `durable sync cursor holds at seq ${flush.last_acked_seq}; resumes on the next call`
    );
  }
  return { local, remoteError: message, remoteQueued: true };
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
