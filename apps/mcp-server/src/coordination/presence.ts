






import type { AgentPresence, WorkClaim } from './types';


export function isExpired(claim: WorkClaim, nowMs: number): boolean {
  const heartbeatMs = Date.parse(claim.heartbeat_at);
  if (Number.isNaN(heartbeatMs)) return true;
  return nowMs - heartbeatMs > claim.ttl_ms;
}















export function reduceClaimLog(log: WorkClaim[]): WorkClaim[] {
  const latest = new Map<string, WorkClaim>();
  for (const claim of log) {
    const existing = latest.get(claim.claim_id);
    if (!existing) {
      latest.set(claim.claim_id, claim);
      continue;
    }
    const bothVersioned = typeof claim.version === 'number' && typeof existing.version === 'number';
    const cmp = bothVersioned
      ? (claim.version as number) - (existing.version as number)
      : claim.seq - existing.seq;
    if (cmp > 0) {
      latest.set(claim.claim_id, claim);
    } else if (cmp === 0) {
      const claimTime = Date.parse(claim.created_at);
      const existingTime = Date.parse(existing.created_at);
      if (claimTime >= existingTime) latest.set(claim.claim_id, claim);
    }
  }
  return [...latest.values()];
}






export function deriveActiveClaims(log: WorkClaim[], nowMs: number = Date.now()): WorkClaim[] {
  return reduceClaimLog(log).filter((c) => c.status === 'active' && !isExpired(c, nowMs));
}






export function derivePresence(
  log: WorkClaim[],
  workspaceId: string,
  nowMs: number = Date.now()
): AgentPresence[] {
  const active = deriveActiveClaims(log, nowMs).filter((c) => c.workspace_id === workspaceId);
  const byAgent = new Map<string, WorkClaim>();
  for (const claim of active) {
    const existing = byAgent.get(claim.agent_id);
    if (!existing || Date.parse(claim.heartbeat_at) > Date.parse(existing.heartbeat_at)) {
      byAgent.set(claim.agent_id, claim);
    }
  }
  return [...byAgent.values()].map((claim) => ({
    agent_id: claim.agent_id,
    agent_kind: claim.agent_kind,
    workspace: claim.workspace_id,
    last_seen: claim.heartbeat_at,
    scope: {
      repo: claim.scope.repo,
      paths: claim.scope.paths,
      symbols: claim.scope.symbols,
      capability: claim.scope.capability,
    },
    base_commit: claim.base_commit,
  }));
}
