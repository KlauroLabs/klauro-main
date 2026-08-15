

















import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { appendClaim, getBoardInfo, getStoreDir, readClaimLog, type ClaimLogEntry } from './local-store';
import { reduceClaimLog } from './presence';
import type { AgentPresence, WorkClaim } from './types';
import type { SymbolChange } from './conceptual-conflict';
import type { InFlightAttributionSource } from './participant-in-flight-store';


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


export interface RemoteState {
  workspace: string;
  max_seq: number;
  claims: WorkClaim[];
  presence: AgentPresence[];

  epoch?: string;

  min_retained_seq?: number;

  gap?: string;
  in_flight?: Array<{
    agent_id: string;
    base_commit: string;
    branch?: string;
    updated_at: string;
    attribution_source: InFlightAttributionSource;
    changes_count: number;
    changes: SymbolChange[];
  }>;
}









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


export interface RemoteSyncOptions {
  baseUrl: string;
  token?: string;
}

export interface SyncClaimResult {

  local: ClaimLogEntry;

  remote?: PublishClaimResult;

  remoteError?: string;

  remoteQueued?: boolean;
}




























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

  published: number;

  skipped: number;

  pending: number;

  last_acked_seq: number;

  error?: string;

  results: Map<number, PublishClaimResult>;
}










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
      break;
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


export function __resetRemoteSyncForTests(): void {
  flushBackoff.clear();
}











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

    console.error(
      `[coordination/remote-store] syncClaim: remote publish failed, local write kept (${message}) — ` +
        `durable sync cursor holds at seq ${flush.last_acked_seq}; resumes on the next call`
    );
  }
  return { local, remoteError: message, remoteQueued: true };
}







export function mergeRemotePeers(localActive: WorkClaim[], remoteState: RemoteState | undefined): WorkClaim[] {
  const combined = [...localActive, ...(remoteState?.claims ?? [])];
  return reduceClaimLog(combined).filter((c) => c.status === 'active');
}
