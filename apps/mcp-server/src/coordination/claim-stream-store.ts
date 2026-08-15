import { readClaimLog, withWorkspaceLock, type ClaimLogEntry } from './local-store';
import { deriveActiveClaims, isExpired, reduceClaimLog } from './presence';
import type { AgentKind, ConceptualCoordinate, ConflictKind } from './types';

export type ClaimStreamVerdict = 'granted';

export interface ClaimStreamRequest {
  workspace_id: string;
  agent_id: string;
  agent_kind: AgentKind;
  scope: { repo: string; paths: string[]; symbols: string[]; capability?: string; concept?: ConceptualCoordinate };
  intent: string;
  ttl_ms?: number;
}

export interface ClaimStreamOverlap {
  holder_agent_id: string;
  overlapping_symbols: string[];
  overlapping_paths: string[];
  kind: ConflictKind;
}

export interface ClaimStreamResult {
  verdict: ClaimStreamVerdict;
  claim_id?: string;
  lease_expires_at?: string;
  queue_position?: number;
  conflict?: ClaimStreamOverlap;
  redirect_hint?: string;
}

export interface ActiveClaimStream {
  claim_id: string;
  agent_id: string;
  scope: ClaimStreamRequest['scope'];
  granted_at: string;
  lease_expires_at: string;
}

interface ClaimStreamMarker {
  __claim_stream__: {
    claim_id: string;
    intent: string;
  };
}

const DEFAULT_GRANT_TTL_MS = 5 * 60 * 1000;

function encodeIntent(marker: ClaimStreamMarker): string {
  return JSON.stringify(marker);
}

function decodeClaimStreamMarker(intent: string): ClaimStreamMarker['__claim_stream__'] | undefined {
  try {
    const parsed = JSON.parse(intent);
    if (!parsed || typeof parsed !== 'object') return undefined;
    if (parsed.__claim_stream__) return parsed.__claim_stream__ as ClaimStreamMarker['__claim_stream__'];
    return parsed.__grant__
      ? { claim_id: parsed.__grant__.grant_id, intent: parsed.__grant__.intent }
      : undefined;
  } catch {
    return undefined;
  }
}

function grantClaimsFromLog(log: ClaimLogEntry[], workspaceId: string, nowMs: number) {
  return deriveActiveClaims(log, nowMs)
    .filter((claim) => claim.workspace_id === workspaceId)
    .flatMap((claim) => {
      const marker = decodeClaimStreamMarker(claim.intent);
      return marker ? [{ claim, marker }] : [];
    });
}

function newClaimStreamId(): string {
  return `stream_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function storedClaimId(workspaceId: string, claimStreamId: string): string {
  return `stream:${workspaceId}:${claimStreamId}`;
}

function sameStringSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value) => new Set(b).has(value));
}

function pathsOverlap(a: string, b: string): boolean {
  const left = a.replace(/\/+$/, '');
  const right = b.replace(/\/+$/, '');
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function scopesOverlap(a: ClaimStreamRequest['scope'], b: ClaimStreamRequest['scope']) {
  const symbols = a.symbols.filter((symbol) => b.symbols.includes(symbol));
  const paths = a.paths.flatMap((path) => b.paths.filter((other) => pathsOverlap(path, other)));
  return symbols.length || paths.length ? { symbols, paths: [...new Set(paths)] } : undefined;
}

function conflictFor(req: ClaimStreamRequest, active: ReturnType<typeof grantClaimsFromLog>): ClaimStreamOverlap | undefined {
  for (const { claim } of active) {
    if (claim.agent_id === req.agent_id) continue;
    const overlap = scopesOverlap(req.scope, claim.scope);
    if (!overlap) continue;
    return {
      holder_agent_id: claim.agent_id,
      overlapping_symbols: overlap.symbols,
      overlapping_paths: overlap.paths,
      kind: overlap.symbols.length ? 'symbol' : 'path',
    };
  }
  return undefined;
}

function toActiveClaimStream(entry: ReturnType<typeof grantClaimsFromLog>[number]): ActiveClaimStream {
  return {
    claim_id: entry.marker.claim_id,
    agent_id: entry.claim.agent_id,
    scope: entry.claim.scope,
    granted_at: entry.claim.created_at,
    lease_expires_at: new Date(Date.parse(entry.claim.heartbeat_at) + entry.claim.ttl_ms).toISOString(),
  };
}

export async function publishClaimStream(req: ClaimStreamRequest): Promise<ClaimStreamResult> {
  return withWorkspaceLock(req.workspace_id, async ({ log, append }) => {
    const nowMs = Date.now();
    const active = grantClaimsFromLog(log, req.workspace_id, nowMs);
    const existing = active.find(({ claim }) =>
      claim.agent_id === req.agent_id &&
      claim.scope.repo === req.scope.repo &&
      sameStringSet(claim.scope.paths, req.scope.paths) &&
      sameStringSet(claim.scope.symbols, req.scope.symbols)
    );
    if (existing) {
      return {
        verdict: 'granted',
        claim_id: existing.marker.claim_id,
        lease_expires_at: toActiveClaimStream(existing).lease_expires_at,
      };
    }

    const claimStreamId = newClaimStreamId();
    const now = new Date(nowMs).toISOString();
    const ttlMs = req.ttl_ms ?? DEFAULT_GRANT_TTL_MS;
    await append({
      claim_id: storedClaimId(req.workspace_id, claimStreamId),
      workspace_id: req.workspace_id,
      agent_id: req.agent_id,
      agent_kind: req.agent_kind,
      scope: req.scope,
      intent: encodeIntent({ __claim_stream__: { claim_id: claimStreamId, intent: req.intent } }),
      status: 'active',
      created_at: now,
      ttl_ms: ttlMs,
      heartbeat_at: now,
    });
    const conflict = conflictFor(req, active);
    return {
      verdict: 'granted',
      claim_id: claimStreamId,
      lease_expires_at: new Date(nowMs + ttlMs).toISOString(),
      conflict,
      redirect_hint: conflict
        ? 'Overlap is advisory. Both streams remain active; use the shared context to collaborate and reconcile intent.'
        : undefined,
    };
  });
}

export async function releaseClaimStream(workspaceId: string, agentId: string, claimStreamId: string) {
  return withWorkspaceLock(workspaceId, async ({ log, append }) => {
    const found = grantClaimsFromLog(log, workspaceId, Date.now()).find(({ claim, marker }) =>
      marker.claim_id === claimStreamId && claim.agent_id === agentId
    );
    if (!found) return { released: false };
    const prior = found.claim;
    await append({
      claim_id: prior.claim_id,
      workspace_id: workspaceId,
      agent_id: agentId,
      agent_kind: prior.agent_kind,
      scope: prior.scope,
      intent: prior.intent,
      status: 'released',
      created_at: prior.created_at,
      ttl_ms: prior.ttl_ms,
      heartbeat_at: new Date().toISOString(),
    });
    return { released: true };
  });
}

export async function heartbeatClaimStream(workspaceId: string, claimStreamId: string) {
  return withWorkspaceLock(workspaceId, async ({ log, append }) => {
    const nowMs = Date.now();
    const found = grantClaimsFromLog(log, workspaceId, nowMs).find(({ marker }) => marker.claim_id === claimStreamId);
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

export async function getClaimStreams(workspaceId: string): Promise<{ active: ActiveClaimStream[] }> {
  const active = grantClaimsFromLog(await readClaimLog(workspaceId), workspaceId, Date.now());
  return { active: active.map(toActiveClaimStream) };
}

export const __internal = { decodeClaimStreamMarker, reduceClaimLog, isExpired };
