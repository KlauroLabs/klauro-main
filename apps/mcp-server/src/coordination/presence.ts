/**
 * Pure presence/claim-log helpers (§WS-C). No IO: callers own the append-only
 * claim log and pass it in; these functions derive active-set/expiry/presence
 * views from it. Consistency model: last-writer-wins per `claim_id`, ordered
 * by the monotonic `seq` field on each logged claim.
 */

import type { AgentPresence, WorkClaim } from './types';

/** True when `claim`'s heartbeat is older than its TTL, as of `nowMs`. */
export function isExpired(claim: WorkClaim, nowMs: number): boolean {
  const heartbeatMs = Date.parse(claim.heartbeat_at);
  if (Number.isNaN(heartbeatMs)) return true;
  return nowMs - heartbeatMs > claim.ttl_ms;
}

/**
 * Reduce an append-only claim log (any order, possibly containing multiple
 * entries per `claim_id`) to the latest entry per `claim_id` (last-writer-wins).
 *
 * Precedence per claim_id (Coordination Engine wave 1):
 *  1. WRITER-OWNED `version`, when BOTH entries carry one — the only key that
 *     is comparable ACROSS stores (a local log and a remote board have
 *     incomparable seq domains: a stale local seq 900 must never beat a
 *     fresher remote seq 12 for the same claim).
 *  2. `seq` — the LEGACY rule, used whenever either entry predates the
 *     `version` field. Within one board's own log this is still correct
 *     (seq is that board's arrival order).
 *  3. Ties broken by `created_at` recency, then insertion order.
 */
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

/**
 * Derive the active-claim set from an append-only claim log: last-writer-wins
 * per `claim_id`, filtered to `status === 'active'` and not TTL-expired as of
 * `nowMs` (defaults to `Date.now()`).
 */
export function deriveActiveClaims(log: WorkClaim[], nowMs: number = Date.now()): WorkClaim[] {
  return reduceClaimLog(log).filter((c) => c.status === 'active' && !isExpired(c, nowMs));
}

/**
 * Derive the live agent-presence roster for a workspace from an append-only
 * claim log: one entry per agent, using their most-recently-heartbeated
 * active (non-expired) claim as the presence scope.
 */
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
