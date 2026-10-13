import { getAnalysis } from '../analyzer';
import type { AccountStore } from '../account-store';
import type { AgentKind } from './index';
import type { AgentInFlightState, ConflictCas, SymbolChange } from './conceptual-conflict';
import { appendClaim, getActiveClaims, readClaimLog } from './local-store';
import { deriveActiveClaims } from './presence';
import type { PartitionCas } from './partitioner';
import { readParticipantInFlightSnapshots } from './participant-in-flight-store';

const CONCEPTUAL_CLAIM_TTL_MS_HTTP = 30 * 60 * 1000;

interface ConceptualMarkerHttp {
  __conceptual__: { intent: string; changes: SymbolChange[]; reported_at: string };
}

function conceptualClaimIdHttp(workspaceId: string, agentId: string): string {
  return `conceptual:${workspaceId}:${agentId}`;
}

function decodeConceptualMarkerHttp(intent: string): ConceptualMarkerHttp['__conceptual__'] | undefined {
  try {
    const parsed = JSON.parse(intent);
    if (parsed && typeof parsed === 'object' && parsed.__conceptual__) {
      return parsed.__conceptual__ as ConceptualMarkerHttp['__conceptual__'];
    }
  } catch {

  }
  return undefined;
}

export async function reportConceptualChangesHttp(
  workspace: string,
  agentId: string,
  agentKind: AgentKind,
  intent: string,
  changes: SymbolChange[]
): Promise<void> {
  const now = new Date().toISOString();
  await appendClaim(workspace, {
    claim_id: conceptualClaimIdHttp(workspace, agentId),
    workspace_id: workspace,
    agent_id: agentId,
    agent_kind: agentKind,
    scope: { repo: workspace, paths: [], symbols: changes.map((c) => c.symbol_id) },
    intent: JSON.stringify({ __conceptual__: { intent, changes, reported_at: now } } satisfies ConceptualMarkerHttp),
    status: 'active',
    created_at: now,
    ttl_ms: CONCEPTUAL_CLAIM_TTL_MS_HTTP,
    heartbeat_at: now,
  });
}

export async function otherAgentConceptualStatesHttp(workspace: string, excludeAgentId: string): Promise<AgentInFlightState[]> {
  const [log, snapshots] = await Promise.all([
    readClaimLog(workspace),
    readParticipantInFlightSnapshots(workspace, { attributableOnly: true }),
  ]);
  const active = deriveActiveClaims(log, Date.now()).filter((c) => c.workspace_id === workspace);
  const states = new Map<string, AgentInFlightState>();
  for (const claim of active) {
    if (claim.agent_id === excludeAgentId) continue;
    const marker = decodeConceptualMarkerHttp(claim.intent);
    if (!marker) continue;
    states.set(claim.agent_id, { agent_id: claim.agent_id, intent: marker.intent, changes: marker.changes });
  }
  for (const snapshot of snapshots) {
    if (snapshot.agent_id === excludeAgentId || !snapshot.changes?.length) continue;
    const existing = states.get(snapshot.agent_id);
    states.set(snapshot.agent_id, {
      agent_id: snapshot.agent_id,
      intent: existing?.intent ?? '',
      changes: snapshot.changes,
    });
  }
  return [...states.values()];
}

export async function conceptualConflictCasForWorkspaceHttp(workspace: string): Promise<ConflictCas> {
  try {
    const cas = await getAnalysis(workspace);
    return {
      nodes: (cas.nodes || []).map((n: any) => ({ id: n.id, name: n.name })),
      edges: (cas.edges || [])
        .filter((e: any) => e.type === 'calls')
        .map((e: any) => ({ source: e.source, target: e.target, type: e.type })),
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

export async function partitionCasForPathHttp(path: string): Promise<PartitionCas> {
  try {
    const cas = await getAnalysis(path);
    const files = new Set<string>();
    for (const n of (cas.nodes || []) as any[]) {
      const f = n?.source?.file;
      if (typeof f === 'string' && f.length > 0) files.add(f);
    }
    return {
      nodes: (cas.nodes || []).map((n: any) => ({ id: n.id, name: n.name })),
      edges: (cas.edges || [])
        .filter((e: any) => e.type === 'calls')
        .map((e: any) => ({ source: e.source, target: e.target, type: e.type })),
      files: [...files],
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

interface GrantHolderContext {
  agent_id: string;
  intent: string;
  granted_at: string;
  lease_expires_at: string;
  lease_status: 'active' | 'near_expiry' | 'expired';
}

export async function describeGrantHolders(
  workspace: string,
  agentIds: string[]
): Promise<Record<string, GrantHolderContext>> {
  if (agentIds.length === 0) return {};
  const wanted = new Set(agentIds);
  const active = await getActiveClaims(workspace);
  const out: Record<string, GrantHolderContext> = {};
  const nowMs = Date.now();
  for (const claim of active) {
    if (!wanted.has(claim.agent_id) || out[claim.agent_id]) continue;
    let markerIntent: string | undefined;
    try {
      const parsed = JSON.parse(claim.intent);
      if (parsed && typeof parsed === 'object' && parsed.__grant__?.kind === 'granted') {
        markerIntent = parsed.__grant__.intent;
      }
    } catch {

    }
    if (markerIntent === undefined) continue;
    const leaseMs = Date.parse(claim.heartbeat_at) + claim.ttl_ms;
    const remainingMs = leaseMs - nowMs;
    out[claim.agent_id] = {
      agent_id: claim.agent_id,
      intent: markerIntent,
      granted_at: claim.created_at,
      lease_expires_at: new Date(leaseMs).toISOString(),
      lease_status: remainingMs <= 0 ? 'expired' : remainingMs < 30_000 ? 'near_expiry' : 'active',
    };
  }
  return out;
}

export async function canAccessCoordinationWorkspace(
  accounts: AccountStore,
  clientId: string,
  workspace: string,
): Promise<boolean> {
  if (clientId === 'shared-token') return true;
  if (!clientId.startsWith('user:')) return false;
  const userId = clientId.slice('user:'.length);
  if (workspace.startsWith('prj_')) {
    try {
      return Boolean(await accounts.getProjectForUser(userId, workspace));
    } catch {
      return false;
    }
  }
  const workspaces = await accounts.listWorkspaces(userId);
  return workspaces.some(candidate => candidate.id === workspace);
}
