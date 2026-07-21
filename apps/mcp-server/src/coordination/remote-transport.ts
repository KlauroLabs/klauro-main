/**
 * Remote ADVISORY fabric transport — the client half of the cross-machine
 * coordination API on `remote-analyzer-service.ts` (§1.1 two-tier model,
 * SPEC-COORDINATION-FABRIC.md / docs/FABRIC-REMOTE.md).
 *
 * Consumed by `scripts/fab.ts` (CLI) and the `fab_*` MCP tools in `server.ts`
 * via `coordination/fabric-config.ts` (resolveFabricSettings): once
 * `klauro fabric on` has persisted `{fabric: {enabled, endpoint, workspace}}`
 * into the repo's .klaurorc, claim/check/release/active go over HTTPS to that
 * service's per-workspace claim log instead of this machine's local
 * filesystem store — which is what lets agents on DIFFERENT machines see each
 * other. `FAB_REMOTE_URL`/`FAB_REMOTE_TOKEN` remain a low-priority CI escape
 * hatch (see getRemoteFabConfig), not the documented setup path.
 *
 * Related-but-different: `remote-store.ts` is the WRITE-THROUGH tier (local
 * append first, best-effort remote publish with a retry queue) used by
 * in-process fabric consumers. THIS module is the PURE-REMOTE transport for
 * the fab surface — in remote mode the server's log is the single source of
 * truth (server-assigned `seq`/`server_time` are authoritative), and the
 * caller (fab.ts / fab_* tools) handles degrade-to-local on network failure.
 * Everything here throws `RemoteFabricError` on any network / non-2xx / parse
 * failure so callers can degrade loudly, never crash.
 */

import type { AgentKind } from './types';
import type { EditLockConflict } from './local-store';

/** Resolved remote-fabric client config (from env unless passed explicitly). */
export interface RemoteFabConfig {
  baseUrl: string;
  token?: string;
}

/**
 * Read the remote-fabric config from the environment — the LOW-PRIORITY CI /
 * ephemeral-container escape hatch, ranked BELOW the .klaurorc fabric section
 * in `fabric-config.ts` resolveFabricSettings (which is the real entry point
 * for fab.ts and the fab_* tools; the documented setup is `klauro fabric on`,
 * not env vars). Returns undefined when `FAB_REMOTE_URL` is unset — callers
 * MUST treat that as "local mode, unchanged behavior" (zero breaking change
 * for existing same-machine use).
 */
export function getRemoteFabConfig(env: NodeJS.ProcessEnv = process.env): RemoteFabConfig | undefined {
  const baseUrl = (env.FAB_REMOTE_URL || '').trim();
  if (!baseUrl) return undefined;
  return { baseUrl, token: env.FAB_REMOTE_TOKEN || undefined };
}

/** Raised on any remote-fabric transport failure (network, non-2xx, bad JSON). */
export class RemoteFabricError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'RemoteFabricError';
  }
}

/**
 * Default TTL sent with remote advisory claims. Mirrors the server-side
 * default (REMOTE_ADVISORY_DEFAULT_TTL_MS in remote-analyzer-service.ts):
 * 30 minutes — WAN-appropriate, so a remote agent that dies expires from the
 * shared awareness view within a bounded window. Heartbeat = re-claim (same
 * claim_id LWW-supersedes and refreshes heartbeat_at). Override per-call or
 * via `FAB_TTL_MS`.
 */
export const REMOTE_ADVISORY_DEFAULT_TTL_MS = 30 * 60 * 1000;

/** Per-request timeout: an advisory awareness call must fail fast, not hang a caller. */
const REQUEST_TIMEOUT_MS = Number(process.env.FAB_REMOTE_TIMEOUT_MS || 10_000);

export interface RemoteClaimResult {
  claim_id: string;
  seq: number;
  /** Writer-owned per-claim version echoed/minted by the board (durable-board protocol). Absent from pre-version servers. */
  version?: number;
  /** Board epoch — clients holding a cursor reset it when this changes. Absent from pre-epoch servers. */
  epoch?: string;
  /** Compaction retention floor — a cursor below this has missed events. */
  min_retained_seq?: number;
  verdict: 'granted';
  mode: 'advisory';
  ttl_ms: number;
  server_time: string;
  conflicts: EditLockConflict[];
  warning?: string;
}

export interface RemoteCheckResult {
  workspace: string;
  paths: string[];
  ok: boolean;
  conflicts: EditLockConflict[];
  server_time: string;
}

export interface RemoteReleaseResult {
  status: 'released';
  mode: 'advisory';
  agent_id: string;
  released_count: number;
  released: Array<{ claim_id: string; intent: string; paths: string[] }>;
  server_time: string;
}

export interface RemoteActiveClaim {
  claim_id: string;
  seq: number;
  agent_id: string;
  agent_kind: AgentKind;
  status: string;
  intent: string;
  paths: string[];
  symbols: string[];
  heartbeat_at: string;
  ttl_ms: number;
}

export interface RemoteActiveResult {
  workspace: string;
  count: number;
  max_seq: number;
  /** Board epoch (durable-board protocol) — cursor holders reset on change. Absent from pre-epoch servers. */
  epoch?: string;
  /** Compaction retention floor — a cursor below this has missed events. */
  min_retained_seq?: number;
  server_time: string;
  active: RemoteActiveClaim[];
}

async function request<T>(config: RemoteFabConfig, method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}${route}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.token) headers.authorization = `Bearer ${config.token}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new RemoteFabricError(`remote fabric unreachable: ${method} ${url}`, err);
  }
  if (!response.ok) {
    let detail: string | undefined;
    try {
      detail = await response.text();
    } catch {
      /* body unreadable — status alone is the signal */
    }
    throw new RemoteFabricError(
      `remote fabric responded ${response.status} for ${method} ${route}${response.status === 401 ? ' — credentials rejected; run `klauro login` (or in CI, check FAB_REMOTE_TOKEN)' : ''}`,
      detail
    );
  }
  try {
    return (await response.json()) as T;
  } catch (err) {
    throw new RemoteFabricError(`remote fabric returned non-JSON for ${method} ${route}`, err);
  }
}

/** POST /v1/coordination/claim (mode:'advisory') — awareness claim on the server's workspace log. */
export async function remoteClaim(
  config: RemoteFabConfig,
  input: {
    workspace: string;
    agentId: string;
    intent: string;
    paths?: string[];
    symbols?: string[];
    agentKind?: AgentKind;
    ttlMs?: number;
    claimId?: string;
  }
): Promise<RemoteClaimResult> {
  return request<RemoteClaimResult>(config, 'POST', '/v1/coordination/claim', {
    mode: 'advisory',
    workspace: input.workspace,
    agent_id: input.agentId,
    intent: input.intent,
    agent_kind: input.agentKind ?? 'claude',
    paths: input.paths ?? [],
    symbols: input.symbols ?? [],
    ttl_ms: input.ttlMs ?? REMOTE_ADVISORY_DEFAULT_TTL_MS,
    claim_id: input.claimId,
  });
}

/** POST /v1/coordination/check — read-only overlap preflight against the server's workspace log. */
export async function remoteCheck(
  config: RemoteFabConfig,
  input: { workspace: string; agentId?: string; paths: string[] }
): Promise<RemoteCheckResult> {
  return request<RemoteCheckResult>(config, 'POST', '/v1/coordination/check', {
    workspace: input.workspace,
    agent_id: input.agentId,
    paths: input.paths,
  });
}

/** POST /v1/coordination/release (no claim_id) — release EVERY advisory claim the agent holds. */
export async function remoteRelease(
  config: RemoteFabConfig,
  input: { workspace: string; agentId: string }
): Promise<RemoteReleaseResult> {
  return request<RemoteReleaseResult>(config, 'POST', '/v1/coordination/release', {
    workspace: input.workspace,
    agent_id: input.agentId,
  });
}

/** GET /v1/coordination/active — the live advisory awareness surface for a workspace. */
export async function remoteActive(config: RemoteFabConfig, workspace: string): Promise<RemoteActiveResult> {
  return request<RemoteActiveResult>(config, 'GET', `/v1/coordination/active?workspace=${encodeURIComponent(workspace)}`);
}
