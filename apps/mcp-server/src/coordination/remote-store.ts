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
  /** The remote publish result, if a remote tier was configured and the publish succeeded. */
  remote?: PublishClaimResult;
  /** Set when a remote tier was configured but publishing failed — logged + queued, non-fatal. */
  remoteError?: string;
}

/**
 * Write-through: append `claim` to the LOCAL store FIRST (instant, authoritative
 * for same-host peers), then best-effort publish to the REMOTE tier if
 * `remote` options are supplied. A remote network failure is caught, logged,
 * and reported back via `remoteError` — it never throws and never blocks/undoes
 * the local write (§1.1 invariant).
 *
 * "Queue" here is intentionally minimal: on failure we log to stderr so an
 * operator/dashboard can see the drop. A fuller retry queue is future work
 * (WS-K); the local store is always the source of truth for same-machine
 * peers regardless of remote reachability, so no data is lost — only
 * cross-machine propagation is delayed until the next successful sync.
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

  try {
    const result = await publishClaim(remote.baseUrl, remote.token, local);
    return { local, remote: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[coordination/remote-store] syncClaim: remote publish failed, local write kept (${message})`);
    return { local, remoteError: message };
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
