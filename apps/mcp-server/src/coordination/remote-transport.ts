























import type { AgentKind, ConceptualCoordinate, DeclaredContract } from './types';
import type { EditLockConflict } from './local-store';
import type { SymbolChange } from './conceptual-conflict';
import type { InFlightAttributionSource } from './participant-in-flight-store';
import type { MergelessMetrics } from './mergeless-metrics';


export interface RemoteFabConfig {
  baseUrl: string;
  token?: string;
}










export function getRemoteFabConfig(env: NodeJS.ProcessEnv = process.env): RemoteFabConfig | undefined {
  const baseUrl = (env.FAB_REMOTE_URL || '').trim();
  if (!baseUrl) return undefined;
  return { baseUrl, token: env.FAB_REMOTE_TOKEN || undefined };
}


export class RemoteFabricError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'RemoteFabricError';
  }
}









export const REMOTE_ADVISORY_DEFAULT_TTL_MS = 30 * 60 * 1000;


const REQUEST_TIMEOUT_MS = Number(process.env.FAB_REMOTE_TIMEOUT_MS || 10_000);

export interface RemoteClaimResult {
  claim_id: string;
  seq: number;

  version?: number;

  epoch?: string;

  min_retained_seq?: number;
  verdict: 'granted';
  mode: 'advisory';
  ttl_ms: number;
  server_time: string;
  conflicts: EditLockConflict[];
  conceptual_awareness?: Array<{
    agent_id: string;
    intent: string;
    verdict: 'awareness' | 'conceptual_conflict';
    reason: string;
    shared_flow_id?: string;
    shared_step_id?: string;
    shared_entities?: string[];
  }>;
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
  produces?: DeclaredContract[];
  consumes?: string[];
  concept?: ConceptualCoordinate;
  heartbeat_at: string;
  ttl_ms: number;
}

export interface RemoteActiveResult {
  workspace: string;
  count: number;
  max_seq: number;

  epoch?: string;

  min_retained_seq?: number;
  server_time: string;
  active: RemoteActiveClaim[];
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
    produces?: DeclaredContract[];
    consumes?: string[];
    concept?: ConceptualCoordinate;
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
    produces: input.produces,
    consumes: input.consumes,
    concept: input.concept,
  });
}

export interface RemoteExtendResult {
  status: 'extended';
  workspace: string;
  claim_id: string;
  agent_id: string;
  seq: number;
  paths: string[];
  symbols: string[];
  produces: DeclaredContract[];
  consumes: string[];
  concept?: ConceptualCoordinate;
  conflicts: EditLockConflict[];
  server_time: string;
}

export async function remoteExtend(
  config: RemoteFabConfig,
  input: {
    workspace: string;
    claimId: string;
    addPaths?: string[];
    addSymbols?: string[];
    addProduces?: DeclaredContract[];
    addConsumes?: string[];
    concept?: ConceptualCoordinate;
  }
): Promise<RemoteExtendResult> {
  return request<RemoteExtendResult>(config, 'POST', '/v1/coordination/extend', {
    workspace: input.workspace,
    claim_id: input.claimId,
    add_paths: input.addPaths ?? [],
    add_symbols: input.addSymbols ?? [],
    add_produces: input.addProduces ?? [],
    add_consumes: input.addConsumes ?? [],
    concept: input.concept,
  });
}


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


export async function remoteRelease(
  config: RemoteFabConfig,
  input: { workspace: string; agentId: string }
): Promise<RemoteReleaseResult> {
  return request<RemoteReleaseResult>(config, 'POST', '/v1/coordination/release', {
    workspace: input.workspace,
    agent_id: input.agentId,
  });
}


export async function remoteActive(config: RemoteFabConfig, workspace: string): Promise<RemoteActiveResult> {
  return request<RemoteActiveResult>(config, 'GET', `/v1/coordination/active?workspace=${encodeURIComponent(workspace)}`);
}

export async function remoteMergelessMetrics(config: RemoteFabConfig, workspace: string): Promise<MergelessMetrics> {
  return request<MergelessMetrics>(config, 'GET', `/v1/coordination/metrics?workspace=${encodeURIComponent(workspace)}`);
}
